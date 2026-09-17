import { TestbenchDefaults } from "../config/defaults.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { CommandRunner } from "../infrastructure/command-runner.js";

const ADB_TIMEOUT_MS = 8_000;

export class AndroidDeviceMonitor {
  private timer?: NodeJS.Timeout;
  private fingerprint?: string;
  private running = false;
  private checking = false;

  constructor(
    private readonly onChange: () => void,
    private readonly intervalMs = TestbenchDefaults.ENVIRONMENT_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.checkNow();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async checkNow(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const current = await this.deviceFingerprint();
      if (this.fingerprint !== undefined && current !== this.fingerprint) this.onChange();
      this.fingerprint = current;
    } finally {
      this.checking = false;
      if (this.running) {
        this.timer = setTimeout(() => void this.checkNow(), this.intervalMs);
        this.timer.unref();
      }
    }
  }

  static normalizeDeviceList(output: string): string {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("List of devices") && !line.startsWith("* daemon"))
      .sort()
      .join("\n");
  }

  private async deviceFingerprint(): Promise<string> {
    const sdkRoot = await AndroidSdk.root();
    if (!sdkRoot) return "sdk:missing";
    const result = await CommandRunner.run(AndroidSdk.adb(sdkRoot), ["devices", "-l"], {
      timeoutMs: ADB_TIMEOUT_MS,
    });
    if (result.code !== 0) return `adb:error:${result.code}`;
    return `adb:${AndroidDeviceMonitor.normalizeDeviceList(result.stdout)}`;
  }
}
