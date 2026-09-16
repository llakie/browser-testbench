import type { TargetConfig } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";

const PROCESS_TIMEOUT_MS = 10_000;
const SIMULATOR_SHUTDOWN_TIMEOUT_MS = 30_000;

export class IosSimulatorCleanup {
  static async run(target?: TargetConfig): Promise<void> {
    const udid = target?.udid;
    if (process.platform !== "darwin" || target?.name !== "safari-ios" || !udid) return;

    await CommandRunner.run("xcrun", ["simctl", "terminate", udid, "com.facebook.WebDriverAgentRunner.xctrunner"], {
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    await CommandRunner.run("pkill", ["-f", `WebDriverAgent.xcodeproj.*${udid}`], {
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    await CommandRunner.run("xcrun", ["simctl", "shutdown", udid], {
      timeoutMs: SIMULATOR_SHUTDOWN_TIMEOUT_MS,
    });

    const devices = await CommandRunner.run("xcrun", ["simctl", "list", "devices", "--json"], {
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    if (devices.code === 0 && !this.hasBootedDevice(devices.stdout)) {
      await CommandRunner.run("pkill", ["-x", "Simulator"], { timeoutMs: PROCESS_TIMEOUT_MS });
    }
  }

  private static hasBootedDevice(output: string): boolean {
    try {
      const parsed = JSON.parse(output) as { devices?: Record<string, Array<{ state?: string }>> };
      return Object.values(parsed.devices ?? {}).some((devices) => devices.some((device) => device.state === "Booted"));
    } catch {
      return true;
    }
  }
}
