import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingGeometry } from "../../src/automation/recording-geometry.js";

describe("RecordingGeometry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps the native WebView into video pixels without visible calibration", async () => {
    const png = Buffer.alloc(24);
    png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 0);
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(2400, 20);
    const browser = {
      sessionId: "session",
      execute: vi.fn().mockResolvedValue({
        width: 393,
        height: 750,
        dpr: 2.75,
        orientation: "portrait",
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      }),
      takeScreenshot: vi.fn().mockResolvedValue(png.toString("base64")),
    };
    const values = [
      "WEBVIEW_chrome",
      null,
      { "element-6066-11e4-a52e-4f735466cecf": "webview" },
      { x: 0, y: 173, width: 1080, height: 2063 },
      null,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ value: values.shift() }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const geometry = await RecordingGeometry.capture(
      browser as never,
      { name: "chrome-android", deviceKind: "emulator" },
      4723,
    );

    expect(geometry).toMatchObject({
      video: { width: 1080, height: 2400 },
      viewportCss: { width: 393, height: 750 },
      devicePixelRatio: 2.75,
      viewportInVideo: { x: 0, y: 173, width: 1080, height: 2063 },
      insets: { top: 173, bottom: 164 },
    });
  });
});
