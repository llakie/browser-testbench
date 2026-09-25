import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TestbenchError } from "../errors/testbench-error.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import type { PixelRect } from "./recording-geometry.js";

export class VideoUtilities {
  static async crop(path: string, bounds: PixelRect): Promise<void> {
    const temporary = join(dirname(path), `.${randomUUID()}.crop.mp4`);
    const result = await CommandRunner.run("ffmpeg", [
      "-y",
      "-i",
      path,
      "-vf",
      `crop=${bounds.width}:${bounds.height}:${bounds.x}:${bounds.y}`,
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
      throw new TestbenchError("RECORDING_FINALIZE_FAILED", "Viewport recording could not be cropped.", {
        operation: "recording.crop",
        status: 500,
        details: { bounds, diagnostic: (result.stderr || result.stdout).slice(-4_000) },
      });
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}
