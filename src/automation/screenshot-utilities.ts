import sharp from "sharp";
import { TestbenchError } from "../errors/testbench-error.js";
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
    try {
      const cropped = await sharp(Buffer.from(base64, "base64"))
        .extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height })
        .png()
        .toBuffer();
      return cropped.toString("base64");
    } catch (error) {
      throw new TestbenchError("SCREENSHOT_SCOPE_UNSUPPORTED", "Viewport screenshot could not be cropped.", {
        operation: "screenshot.viewport",
        status: 409,
        details: { bounds, diagnostic: error instanceof Error ? error.message : String(error) },
        cause: error,
      });
    }
  }
}
