import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TestbenchError } from "../errors/testbench-error.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import type { PixelRect } from "./recording-geometry.js";

export class VideoUtilities {
  static async crop(path: string, bounds: PixelRect, durationMs?: number): Promise<void> {
    const durationSeconds = durationMs ? (durationMs / 1_000).toFixed(3) : undefined;
    const filter = [
      "format=yuv444p",
      `crop=${bounds.width}:${bounds.height}:${bounds.x}:${bounds.y}`,
      ...(durationSeconds
        ? ["setpts=N/(30*TB)", "fps=30", `tpad=stop_mode=clone:stop_duration=${durationSeconds}`]
        : []),
    ].join(",");
    await this.transform(path, filter, durationSeconds);
  }

  static async normalizeDuration(path: string, durationMs: number): Promise<void> {
    const durationSeconds = (durationMs / 1_000).toFixed(3);
    await this.transform(
      path,
      `setpts=N/(30*TB),fps=30,tpad=stop_mode=clone:stop_duration=${durationSeconds}`,
      durationSeconds,
    );
  }

  private static async transform(path: string, filter: string, durationSeconds?: string): Promise<void> {
    const temporary = join(dirname(path), `.${randomUUID()}.transform.mp4`);
    const result = await CommandRunner.run("ffmpeg", [
      "-y",
      "-i",
      path,
      "-vf",
      filter,
      ...(durationSeconds ? ["-t", durationSeconds] : []),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-an",
      temporary,
    ]);
    if (result.code !== 0) {
      await rm(temporary, { force: true });
      throw new TestbenchError("RECORDING_FINALIZE_FAILED", "Recording could not be transformed.", {
        operation: "recording.transform",
        status: 500,
        details: { filter, diagnostic: (result.stderr || result.stdout).slice(-4_000) },
      });
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}
