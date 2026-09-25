import type { TargetConfig } from "../config/types.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchError } from "../errors/testbench-error.js";

const ADB_TIMEOUT_MS = 8_000;

export class AndroidUsbNetwork {
  private readonly forwardedPorts = new Set<number>();

  constructor(private readonly target: TargetConfig) {}

  async prepare(url: string): Promise<string> {
    if (this.target.name !== "chrome-android") return url;
    const parsed = new URL(url);
    if (parsed.hostname !== "localhost" && parsed.hostname !== TestbenchDefaults.LOOPBACK_HOST)
      return parsed.toString();
    if (this.target.localOrigins === "emulator-host" && this.target.deviceKind !== "physical") {
      parsed.hostname = TestbenchDefaults.ANDROID_EMULATOR_LOOPBACK_HOST;
      return parsed.toString();
    }
    if (!this.target.udid) throw this.unavailable("The Android target has no ADB device ID.");

    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (!this.forwardedPorts.has(port)) {
      const adb = await this.adb();
      const endpoint = `tcp:${port}`;
      const mappings = await CommandRunner.run(adb, ["-s", this.target.udid, "reverse", "--list"], {
        timeoutMs: ADB_TIMEOUT_MS,
      });
      if (mappings.code !== 0) throw this.unavailable((mappings.stderr || mappings.stdout).trim());
      const existing = this.mapping(mappings.stdout, endpoint);
      if (existing && existing !== endpoint)
        throw this.unavailable(`Device port ${endpoint} is already mapped to ${existing}.`);
      if (existing === endpoint) {
        parsed.hostname = TestbenchDefaults.LOOPBACK_HOST;
        return parsed.toString();
      }
      const result = await CommandRunner.run(adb, ["-s", this.target.udid, "reverse", endpoint, endpoint], {
        timeoutMs: ADB_TIMEOUT_MS,
      });
      if (result.code !== 0) throw this.unavailable((result.stderr || result.stdout).trim());
      this.forwardedPorts.add(port);
    }
    parsed.hostname = TestbenchDefaults.LOOPBACK_HOST;
    return parsed.toString();
  }

  async close(): Promise<void> {
    if (!this.target.udid || this.forwardedPorts.size === 0) return;
    const adb = await this.adb().catch(() => undefined);
    if (!adb) return;
    const results = await Promise.all(
      [...this.forwardedPorts].map((port) =>
        CommandRunner.run(adb, ["-s", this.target.udid!, "reverse", "--remove", `tcp:${port}`], {
          timeoutMs: ADB_TIMEOUT_MS,
        }).then((result) => ({ port, result })),
      ),
    );
    const failures = results.filter(({ result }) => result.code !== 0);
    for (const { port, result } of results) if (result.code === 0) this.forwardedPorts.delete(port);
    if (failures.length > 0) {
      throw new Error(
        `Could not remove Android USB forwarding: ${failures.map(({ port, result }) => `tcp:${port}: ${(result.stderr || result.stdout).trim()}`).join("; ")}`,
      );
    }
  }

  private async adb(): Promise<string> {
    const sdkRoot = await AndroidSdk.root();
    if (!sdkRoot) throw this.unavailable("Android SDK not found for port forwarding.");
    return AndroidSdk.adb(sdkRoot);
  }

  private mapping(output: string, endpoint: string): string | undefined {
    for (const line of output.split(/\r?\n/u)) {
      const columns = line.trim().split(/\s+/u);
      const deviceEndpoint = columns.at(-2);
      const hostEndpoint = columns.at(-1);
      if (deviceEndpoint === endpoint) return hostEndpoint;
    }
    return undefined;
  }

  private unavailable(reason: string): TestbenchError {
    return new TestbenchError("LOCAL_ORIGIN_UNAVAILABLE", `Could not preserve the Android loopback origin: ${reason}`, {
      operation: "localOrigin.reverse",
      status: 409,
      details: {
        platform: "android",
        serial: this.target.udid,
        mode: this.target.localOrigins ?? "reverse",
      },
    });
  }
}
