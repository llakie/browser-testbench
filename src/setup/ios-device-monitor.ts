import { TestbenchDefaults } from "../config/defaults.js";
import { IosDeviceService } from "./ios-device-service.js";

export class IosDeviceMonitor {
  private timer?: NodeJS.Timeout;
  private fingerprint?: string;
  private running = false;
  private checking = false;

  constructor(
    private readonly onChange: () => void,
    private readonly intervalMs = TestbenchDefaults.ENVIRONMENT_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.running || process.platform !== "darwin") return;
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
      const current = await IosDeviceService.deviceFingerprint();
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
}
