import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ScreenshotUtilities } from "../../src/automation/screenshot-utilities.js";

describe("ScreenshotUtilities", () => {
  it("crops a PNG to the requested pixel bounds without external tools", async () => {
    const width = 4;
    const height = 3;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels.set([x * 50, y * 80, 0, 255], offset);
      }
    }
    const source = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();

    const cropped = Buffer.from(
      await ScreenshotUtilities.crop(source.toString("base64"), {
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        coordinateSystem: "video-pixels",
        edges: "left-top-inclusive-right-bottom-exclusive",
      }),
      "base64",
    );
    const decoded = await sharp(cropped).raw().toBuffer({ resolveWithObject: true });

    expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 4 });
    expect([...decoded.data]).toEqual([50, 80, 0, 255, 100, 80, 0, 255, 50, 160, 0, 255, 100, 160, 0, 255]);
  });

  it("returns the structured screenshot error when crop bounds are invalid", async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    await expect(
      ScreenshotUtilities.crop(source.toString("base64"), {
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        coordinateSystem: "video-pixels",
        edges: "left-top-inclusive-right-bottom-exclusive",
      }),
    ).rejects.toMatchObject({ code: "SCREENSHOT_SCOPE_UNSUPPORTED", operation: "screenshot.viewport" });
  });
});
