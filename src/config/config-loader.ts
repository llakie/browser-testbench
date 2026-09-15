import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { InputSchemas } from "./input-schemas.js";
import { TargetRegistry } from "./target-registry.js";
import { TARGET_NAMES, type NormalizedConfig, type TargetConfig, type TestbenchConfig } from "./types.js";

export class ConfigLoader {
  static validate(value: unknown): TestbenchConfig {
    return InputSchemas.config.parse(value) as TestbenchConfig;
  }

  static async find(startDirectory = process.cwd()): Promise<string | undefined> {
    const names = ["testbench.config.json"];
    for (const name of names) {
      const candidate = resolve(startDirectory, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next conventional name.
      }
    }
    return undefined;
  }

  static async load(filePath: string): Promise<NormalizedConfig> {
    const absolutePath = resolve(filePath);
    const configDir = dirname(absolutePath);
    const raw: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
    return this.normalize(this.validate(raw), configDir);
  }

  static fromOptions(options: {
    name?: string;
    url: string;
    targets: string[];
    specs?: string[];
    artifactsDir?: string;
    headless?: boolean;
    targetPolicy?: "available" | "strict";
  }): NormalizedConfig {
    const parsedTargets: TargetConfig[] = options.targets.map((name) => {
      if (!TargetRegistry.isTargetName(name)) {
        throw new Error(`Unknown target '${name}'. Expected one of: ${TARGET_NAMES.join(", ")}`);
      }
      return { name, headless: options.headless };
    });
    return this.normalize(
      {
        name: options.name ?? "ad-hoc",
        baseUrl: options.url,
        targets: parsedTargets,
        specs: options.specs,
        artifactsDir: options.artifactsDir,
        targetPolicy: options.targetPolicy,
      },
      process.cwd(),
    );
  }

  static normalize(config: TestbenchConfig, configDir: string): NormalizedConfig {
    return {
      ...config,
      configDir,
      targets: config.targets
        .map((target) => TargetRegistry.normalize(target))
        .filter((target) => target.enabled !== false),
      artifactsDir: TestbenchPaths.resolveFrom(configDir, config.artifactsDir ?? "artifacts"),
      timeoutMs: config.timeoutMs ?? 30_000,
      maxDesktopWorkers: config.maxDesktopWorkers ?? 2,
      failFast: config.failFast ?? false,
      targetPolicy: config.targetPolicy ?? "strict",
    };
  }

  static withRunOverrides(
    config: NormalizedConfig,
    overrides: {
      targets?: string[];
      specs?: string[];
      headless?: boolean;
      targetPolicy?: "available" | "strict";
    },
  ): NormalizedConfig {
    const requestedTargets = overrides.targets?.map((name) => {
      if (!TargetRegistry.isTargetName(name))
        throw new Error(`Unknown target '${name}'. Expected one of: ${TARGET_NAMES.join(", ")}`);
      return config.targets.find((target) => target.name === name) ?? { name };
    });
    const targets = (requestedTargets ?? config.targets).map((target) => ({
      ...target,
      ...(overrides.headless === true ? { headless: true } : {}),
    }));
    return {
      ...config,
      targets,
      specs: overrides.specs ?? config.specs,
      targetPolicy: overrides.targetPolicy ?? config.targetPolicy,
    };
  }
}
