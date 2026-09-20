import type { TargetConfig } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";

const PROCESS_TIMEOUT_MS = 10_000;
const SIMULATOR_SHUTDOWN_TIMEOUT_MS = 30_000;

export class IosSessionCleanup {
  static async run(target?: TargetConfig): Promise<void> {
    const udid = target?.udid;
    if (process.platform !== "darwin" || target?.name !== "safari-ios" || !udid) return;

    if (target.deviceKind === "physical") {
      await this.stopWebDriverAgent(udid);
      return;
    }

    await CommandRunner.run("xcrun", ["simctl", "terminate", udid, "com.facebook.WebDriverAgentRunner.xctrunner"], {
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    await this.stopWebDriverAgent(udid);
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

  private static async stopWebDriverAgent(udid: string): Promise<void> {
    const pattern = `WebDriverAgent.xcodeproj.*${udid}`;
    await CommandRunner.run("pkill", ["-f", pattern], {
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const running = await CommandRunner.run("pgrep", ["-f", pattern], { timeoutMs: PROCESS_TIMEOUT_MS });
      if (running.code !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`WebDriverAgent for iOS device '${udid}' did not stop.`);
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
