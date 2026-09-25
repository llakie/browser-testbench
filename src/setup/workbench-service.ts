import { TargetRegistry } from "../config/target-registry.js";
import { PackageMetadata } from "../config/package-metadata.js";
import { TARGET_NAMES } from "../config/types.js";
import { DoctorService } from "./doctor-service.js";
import { McpIntegrationService } from "./mcp-integration-service.js";
import { SetupService } from "./setup-service.js";
import { TargetCatalogService } from "./target-catalog-service.js";
import type { WorkbenchBaseState } from "./workbench-types.js";
import { TestbenchDefaults } from "../config/defaults.js";

export class WorkbenchService {
  async state(): Promise<WorkbenchBaseState> {
    const targets = [...TARGET_NAMES];
    const checks = await DoctorService.inspect(targets);
    const [actions, mcpClients] = await Promise.all([
      SetupService.plan(targets, checks),
      McpIntegrationService.statuses(),
    ]);
    TargetCatalogService.update(checks);
    const testTargets = await TargetCatalogService.publicWithCapabilities();

    return {
      platform: process.platform,
      platformLabel: this.platformLabel(),
      architecture: process.arch,
      mcpClients,
      targets: targets.map((name) => ({
        ...TargetRegistry.definitions[name],
        check: checks.find((check) => check.id === name),
      })),
      checks,
      actions,
      testTargets,
      clientInstallCommand: `npm install --save-dev ${PackageMetadata.NAME}`,
      packageName: PackageMetadata.NAME,
    };
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const targets = [...TARGET_NAMES];
    const checks = await DoctorService.inspect(targets);
    TargetCatalogService.update(checks);
    const testTargets = await TargetCatalogService.publicWithCapabilities();
    return {
      platform: process.platform,
      architecture: process.arch,
      targets: targets.map((name) => ({
        ...TargetRegistry.definitions[name],
        check: checks.find((check) => check.id === name),
      })),
      checks,
      testTargets,
      limits: {
        requestBytes: TestbenchDefaults.REQUEST_BODY_LIMIT_BYTES,
        assetBytes: TestbenchDefaults.ASSET_LIMIT_BYTES,
        sessionAssetBytes: TestbenchDefaults.SESSION_ASSET_TOTAL_LIMIT_BYTES,
      },
    };
  }

  private platformLabel(): string {
    if (process.platform === "darwin") return "macOS";
    if (process.platform === "win32") return "Windows";
    return "Linux";
  }
}
