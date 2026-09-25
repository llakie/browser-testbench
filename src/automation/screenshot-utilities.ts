import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestbenchError } from "../errors/testbench-error.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { ImageDimensions, type PixelRect } from "./recording-geometry.js";

export type ScreenshotScope = "screen" | "viewport" | "fullPage" | "element";

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  scope: ScreenshotScope;
  screenBounds: PixelRect | null;
  viewportBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    coordinateSystem: "viewport-css-pixels";
    edges: "left-top-inclusive-right-bottom-exclusive";
  } | null;
}

export class ScreenshotUtilities {
  static result(
    base64: string,
    scope: ScreenshotScope,
    screenBounds: PixelRect | null,
    viewportBounds: ScreenshotResult["viewportBounds"],
  ): ScreenshotResult {
    return { base64, ...ImageDimensions.png(Buffer.from(base64, "base64")), scope, screenBounds, viewportBounds };
  }

  static async crop(base64: string, bounds: PixelRect): Promise<string> {
    const id = randomUUID();
    const input = join(tmpdir(), `browser-testbench-${id}.png`);
    const output = join(tmpdir(), `browser-testbench-${id}-crop.png`);
    try {
      await writeFile(input, Buffer.from(base64, "base64"));
      const result = await CommandRunner.run("ffmpeg", [
        "-y",
        "-i",
        input,
        "-vf",
        `crop=${bounds.width}:${bounds.height}:${bounds.x}:${bounds.y}`,
        "-frames:v",
        "1",
        output,
      ]);
      if (result.code !== 0)
        throw new TestbenchError("SCREENSHOT_SCOPE_UNSUPPORTED", "Viewport screenshot could not be cropped.", {
          operation: "screenshot.viewport",
          status: 409,
          details: { bounds, diagnostic: (result.stderr || result.stdout).slice(-4_000) },
        });
      return (await readFile(output)).toString("base64");
    } finally {
      await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    }
  }
}
