import { ConfigFileStore } from "../config/config-file-store.js";
import { TargetRegistry } from "../config/target-registry.js";
import type { TargetName } from "../config/types.js";
import { DoctorService } from "./doctor-service.js";
import { SetupService } from "./setup-service.js";

export class WorkbenchService {
  constructor(private readonly configs: ConfigFileStore) {}

  async state(): Promise<Record<string, unknown>> {
    const stored = await this.configs.read();
    const supportedTargets = TargetRegistry.defaultTargets();
    const selectedTargets = stored.config.targets
      .map((target) => (typeof target === "string" ? target : target.name))
      .filter(
        (target): target is TargetName => TargetRegistry.isTargetName(target) && TargetRegistry.isSupported(target),
      );
    const [checks, actions] = await Promise.all([
      DoctorService.inspect(supportedTargets),
      SetupService.plan(selectedTargets),
    ]);

    return {
      platform: process.platform,
      platformLabel: this.platformLabel(),
      architecture: process.arch,
      config: stored.config,
      configExists: stored.exists,
      configPath: this.configs.displayPath(),
      targets: supportedTargets.map((name) => ({
        ...TargetRegistry.definitions[name],
        check: checks.find((check) => check.id === name),
      })),
      checks,
      actions,
    };
  }

  private platformLabel(): string {
    if (process.platform === "darwin") return "macOS";
    if (process.platform === "win32") return "Windows";
    return "Linux";
  }
}
