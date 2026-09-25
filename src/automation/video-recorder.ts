import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { TargetConfig } from "../config/types.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { ProcessTerminator } from "../infrastructure/process-terminator.js";
import { MediaTooling } from "../infrastructure/media-tooling.js";
import { AndroidDeviceUtilities } from "./android-device-utilities.js";

const ADB_COMMAND_TIMEOUT_MS = 5_000;
const RECORDER_STOP_TIMEOUT_MS = 10_000;
const VIDEO_PULL_TIMEOUT_MS = 60_000;
const RECORDER_START_GRACE_PERIOD_MS = 300;

export interface RecordingArtifact {
  path: string;
  size: number;
  sha256: string;
  mimeType: "video/mp4";
  container: string;
  codec: string;
  width: number;
  height: number;
  durationMs: number;
  timeBase: string;
  averageFrameRate: number;
  frameRateMode: "constant" | "variable";
}

interface ProbeOutput {
  streams?: Array<{
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    time_base?: string;
  }>;
  format?: { format_name?: string; duration?: string };
}

export class VideoRecorder {
  private stopResult?: Promise<RecordingArtifact>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly outputPath: string,
    private readonly android?: { adb: string; serial: string; remotePath: string },
  ) {}

  static async start(
    target: TargetConfig,
    outputPath: string,
    capabilities: Record<string, unknown>,
  ): Promise<VideoRecorder> {
    if (!MediaTooling.isAvailable()) throw this.unsupported(target, "FFmpeg and ffprobe are required for recording.");
    await mkdir(dirname(outputPath), { recursive: true });
    if (target.name === "safari-ios") {
      const child = spawn("xcrun", ["simctl", "io", "booted", "recordVideo", "--codec=h264", outputPath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await this.ensureStarted(child, "iOS video recorder");
      return new VideoRecorder(child, outputPath);
    }
    if (target.name === "chrome-android") {
      const sdkRoot = await AndroidSdk.root();
      if (!sdkRoot) throw this.unsupported(target, "Android SDK not found for video recording.");
      const adb = AndroidSdk.adb(sdkRoot);
      const serial = await this.androidSerial(adb, target, capabilities);
      const remotePath = `/sdcard/browser-testbench-${Date.now()}.mp4`;
      const child = spawn(adb, ["-s", serial, "shell", "screenrecord", remotePath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await this.ensureStarted(child, "Android video recorder");
      return new VideoRecorder(child, outputPath, { adb, serial, remotePath });
    }
    throw this.unsupported(target, `Video recording is not supported for '${target.name}'.`);
  }

  stop(signal?: AbortSignal): Promise<RecordingArtifact> {
    this.stopResult ??= this.finalize();
    if (!signal) return this.stopResult;
    return this.stopResult.then((artifact) => {
      if (signal.aborted)
        throw new TestbenchError(
          "OPERATION_ABORTED",
          "Recording finalization was aborted after safe recorder cleanup.",
          {
            operation: "recording.stop",
            status: 499,
            details: { partialArtifact: artifact },
          },
        );
      return artifact;
    });
  }

  private async finalize(): Promise<RecordingArtifact> {
    try {
      if (this.android) {
        await CommandRunner.run(this.android.adb, ["-s", this.android.serial, "shell", "pkill", "-2", "screenrecord"], {
          timeoutMs: ADB_COMMAND_TIMEOUT_MS,
        });
      } else {
        await ProcessTerminator.stop(this.child, { gracefulSignal: "SIGINT", graceMs: RECORDER_STOP_TIMEOUT_MS });
      }
      if (this.android) await this.finalizeAndroid();
      return await RecordingProbe.inspect(this.outputPath);
    } catch (error) {
      if (error instanceof TestbenchError) throw error;
      const partial = await stat(this.outputPath).catch(() => undefined);
      throw new TestbenchError("RECORDING_FINALIZE_FAILED", "Recording could not be finalized.", {
        operation: "recording.stop",
        status: 500,
        cause: error,
        details: {
          path: this.outputPath,
          ...(partial ? { partialBytes: partial.size } : {}),
        },
      });
    }
  }

  private async finalizeAndroid(): Promise<void> {
    if (!this.android) return;
    if (!(await ProcessTerminator.wait(this.child, RECORDER_STOP_TIMEOUT_MS))) {
      const forced = await CommandRunner.run(
        this.android.adb,
        ["-s", this.android.serial, "shell", "pkill", "-9", "screenrecord"],
        { timeoutMs: ADB_COMMAND_TIMEOUT_MS },
      );
      await ProcessTerminator.stop(this.child, { graceMs: RECORDER_STOP_TIMEOUT_MS });
      if (forced.code !== 0)
        throw new Error(`Could not stop Android video recording: ${forced.stderr || forced.stdout}`);
    }
    const pulled = await CommandRunner.run(
      this.android.adb,
      ["-s", this.android.serial, "pull", this.android.remotePath, this.outputPath],
      { timeoutMs: VIDEO_PULL_TIMEOUT_MS },
    );
    const removed = await CommandRunner.run(
      this.android.adb,
      ["-s", this.android.serial, "shell", "rm", this.android.remotePath],
      { timeoutMs: ADB_COMMAND_TIMEOUT_MS },
    );
    if (pulled.code !== 0) throw new Error(`Could not retrieve Android video: ${pulled.stderr || pulled.stdout}`);
    if (removed.code !== 0)
      throw new Error(`Could not remove the temporary Android video: ${removed.stderr || removed.stdout}`);
  }

  private static async androidSerial(
    adb: string,
    target: TargetConfig,
    capabilities: Record<string, unknown>,
  ): Promise<string> {
    const serial = await AndroidDeviceUtilities.serial(adb, target, capabilities);
    if (!serial) throw new Error("No connected Android device was found for video recording.");
    return serial;
  }

  private static async ensureStarted(child: ChildProcess, label: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const complete = (error?: Error): void => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error): void => complete(error);
      const onExit = (code: number | null): void =>
        complete(new Error(`${label} exited immediately with code ${code ?? "unknown"}.`));
      const timer = setTimeout(() => complete(), RECORDER_START_GRACE_PERIOD_MS);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  private static unsupported(target: TargetConfig, message: string): TestbenchError {
    return new TestbenchError("RECORDING_UNSUPPORTED", message, {
      operation: "recording.start",
      status: 409,
      details: { target: target.name, deviceKind: target.deviceKind },
    });
  }
}

export class RecordingProbe {
  static async inspect(path: string): Promise<RecordingArtifact> {
    const file = await stat(path);
    if (!file.isFile() || file.size === 0) throw new Error("Video recorder produced an empty file.");
    const result = await CommandRunner.run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,time_base:format=format_name,duration",
      "-of",
      "json",
      path,
    ]);
    if (result.code !== 0) throw new Error(`ffprobe could not read the recording: ${result.stderr || result.stdout}`);
    const probe = JSON.parse(result.stdout) as ProbeOutput;
    const stream = probe.streams?.[0];
    if (!stream?.codec_name || !stream.width || !stream.height)
      throw new Error("Recording has no readable video stream.");
    const averageFrameRate = this.rate(stream.avg_frame_rate);
    const nominalFrameRate = this.rate(stream.r_frame_rate);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return {
      path,
      size: file.size,
      sha256: hash.digest("hex"),
      mimeType: "video/mp4",
      container: probe.format?.format_name?.split(",")[0] ?? "unknown",
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      durationMs: Math.round(Number(probe.format?.duration ?? 0) * 1_000),
      timeBase: stream.time_base ?? "unknown",
      averageFrameRate,
      frameRateMode: Math.abs(averageFrameRate - nominalFrameRate) < 0.001 ? "constant" : "variable",
    };
  }

  private static rate(value?: string): number {
    if (!value) return 0;
    const [numerator, denominator = "1"] = value.split("/");
    const result = Number(numerator) / Number(denominator);
    return Number.isFinite(result) ? result : 0;
  }
}
