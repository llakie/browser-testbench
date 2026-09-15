import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TargetConfig } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { DoctorService } from "../setup/doctor-service.js";

export class VideoRecorder {
  private constructor(
    private readonly child: ChildProcess,
    private readonly outputPath: string,
    private readonly android?: { adb: string; serial: string; remotePath: string },
  ) {}

  static async start(
    target: TargetConfig,
    targetDirectory: string,
    capabilities: Record<string, unknown>,
  ): Promise<VideoRecorder> {
    await mkdir(targetDirectory, { recursive: true });
    const outputPath = join(targetDirectory, "session.mp4");
    if (target.name === "safari-ios") {
      const child = spawn("xcrun", ["simctl", "io", "booted", "recordVideo", "--codec=h264", outputPath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await this.ensureStarted(child, "iOS video recorder");
      return new VideoRecorder(child, outputPath);
    }
    if (target.name === "chrome-android") {
      const sdkRoot = await DoctorService.androidSdkRoot();
      if (!sdkRoot) throw new Error("Android SDK not found for video recording.");
      const adb = join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
      const serial = await this.androidSerial(adb, target, capabilities);
      const remotePath = `/sdcard/browser-testbench-${Date.now()}.mp4`;
      const child = spawn(adb, ["-s", serial, "shell", "screenrecord", remotePath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await this.ensureStarted(child, "Android video recorder");
      return new VideoRecorder(child, outputPath, { adb, serial, remotePath });
    }
    throw new Error(`Video recording is supported only for mobile targets, not '${target.name}'.`);
  }

  async stop(): Promise<string> {
    if (this.android) {
      await CommandRunner.run(this.android.adb, ["-s", this.android.serial, "shell", "pkill", "-2", "screenrecord"], {
        timeoutMs: 5_000,
      });
    } else {
      this.child.kill("SIGINT");
    }
    await Promise.race([once(this.child, "close"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    if (this.android) {
      const pulled = await CommandRunner.run(
        this.android.adb,
        ["-s", this.android.serial, "pull", this.android.remotePath, this.outputPath],
        { timeoutMs: 60_000 },
      );
      await CommandRunner.run(this.android.adb, ["-s", this.android.serial, "shell", "rm", this.android.remotePath], {
        timeoutMs: 5_000,
      });
      if (pulled.code !== 0) throw new Error(`Could not retrieve Android video: ${pulled.stderr || pulled.stdout}`);
    }
    const file = await stat(this.outputPath);
    if (file.size === 0) throw new Error("Video recorder produced an empty file.");
    return this.outputPath;
  }

  private static async androidSerial(
    adb: string,
    target: TargetConfig,
    capabilities: Record<string, unknown>,
  ): Promise<string> {
    const configured = target.capabilities?.["appium:udid"] ?? capabilities.deviceUDID ?? capabilities.udid;
    if (typeof configured === "string" && configured) return configured;
    const devices = await CommandRunner.run(adb, ["devices"], { timeoutMs: 5_000 });
    const serial = devices.stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^(emulator-\d+)\s+device$/)?.[1])
      .find(Boolean);
    if (!serial) throw new Error("No running Android emulator was found for video recording.");
    return serial;
  }

  private static async ensureStarted(child: ChildProcess, label: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`${label} exited immediately with code ${code ?? "unknown"}.`));
      });
    });
  }
}
