import type { TargetConfig } from "../config/types.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { CommandRunner } from "../infrastructure/command-runner.js";

export class AndroidDeviceUtilities {
  static configuredSerial(target: TargetConfig, capabilities: Record<string, unknown> = {}): string | undefined {
    const configured =
      target.udid ?? target.capabilities?.["appium:udid"] ?? capabilities.deviceUDID ?? capabilities.udid;
    return typeof configured === "string" && configured ? configured : undefined;
  }

  static async serial(
    adb: string,
    target: TargetConfig,
    capabilities: Record<string, unknown> = {},
  ): Promise<string | undefined> {
    const configured = this.configuredSerial(target, capabilities);
    if (configured) return configured;
    const devices = await CommandRunner.run(adb, ["devices"], {
      timeoutMs: TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS,
    });
    return devices.stdout
      .split(/\r?\n/u)
      .map((line) => line.match(/^(\S+)\s+device(?:\s|$)/u)?.[1])
      .find(Boolean);
  }
}
