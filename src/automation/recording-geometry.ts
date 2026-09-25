import type { TargetConfig } from "../config/types.js";
import { TestbenchError } from "../errors/testbench-error.js";
import type { BrowserHandle } from "./browser-session.js";
import { AppiumSessionClient } from "./appium-session-client.js";

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSystem: "video-pixels";
  edges: "left-top-inclusive-right-bottom-exclusive";
}

export interface GeometrySample {
  sessionTimeMs?: number;
  orientation: "portrait" | "landscape";
  video: { width: number; height: number };
  viewportCss: { width: number; height: number };
  devicePixelRatio: number;
  viewportInVideo: PixelRect;
  insets: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    system: null;
    browser: null;
    safeAreaCss: { top: number; right: number; bottom: number; left: number };
  };
  screenshotMatchesVideoBounds: true;
}

interface BrowserGeometry {
  width: number;
  height: number;
  dpr: number;
  orientation: "portrait" | "landscape";
  safeArea: { top: number; right: number; bottom: number; left: number };
}

export class RecordingGeometry {
  static async capture(browser: BrowserHandle, target: TargetConfig, appiumPort?: number): Promise<GeometrySample> {
    const browserGeometry = await browser.execute<BrowserGeometry>(`
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.documentElement.append(probe);
      const style = getComputedStyle(probe);
      const result = {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        orientation: innerWidth > innerHeight ? 'landscape' : 'portrait',
        safeArea: {
          top: parseFloat(style.paddingTop) || 0,
          right: parseFloat(style.paddingRight) || 0,
          bottom: parseFloat(style.paddingBottom) || 0,
          left: parseFloat(style.paddingLeft) || 0,
        },
      };
      probe.remove();
      return result;
    `);
    const screenshot = Buffer.from(await this.screenScreenshot(browser, appiumPort), "base64");
    const video = ImageDimensions.png(screenshot);
    const rect = await this.nativeWebViewRect(browser, browserGeometry, target, appiumPort).catch((error) => {
      throw new TestbenchError("RECORDING_UNSUPPORTED", "Browser viewport bounds could not be determined safely.", {
        operation: "recording.geometry",
        status: 409,
        cause: error,
        details: { target: target.name, deviceKind: target.deviceKind },
      });
    });
    const viewportInVideo: PixelRect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      coordinateSystem: "video-pixels",
      edges: "left-top-inclusive-right-bottom-exclusive",
    };
    return {
      orientation: browserGeometry.orientation,
      video,
      viewportCss: { width: browserGeometry.width, height: browserGeometry.height },
      devicePixelRatio: browserGeometry.dpr,
      viewportInVideo,
      insets: {
        top: viewportInVideo.y,
        left: viewportInVideo.x,
        right: Math.max(0, video.width - viewportInVideo.x - viewportInVideo.width),
        bottom: Math.max(0, video.height - viewportInVideo.y - viewportInVideo.height),
        system: null,
        browser: null,
        safeAreaCss: browserGeometry.safeArea,
      },
      screenshotMatchesVideoBounds: true,
    };
  }

  static equal(left: GeometrySample, right: GeometrySample): boolean {
    return JSON.stringify(left.viewportInVideo) === JSON.stringify(right.viewportInVideo);
  }

  static async screenScreenshot(browser: BrowserHandle, appiumPort?: number): Promise<string> {
    if (!appiumPort) return browser.takeScreenshot();
    const client = new AppiumSessionClient(appiumPort, browser.sessionId);
    const original = await client.request<string>("context");
    try {
      await client.request("context", "POST", { name: "NATIVE_APP" });
      return await client.request<string>("screenshot");
    } finally {
      await client.request("context", "POST", { name: original });
    }
  }

  private static async nativeWebViewRect(
    browser: BrowserHandle,
    browserGeometry: BrowserGeometry,
    target: TargetConfig,
    appiumPort?: number,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    if (!appiumPort) {
      const size = ImageDimensions.png(Buffer.from(await browser.takeScreenshot(), "base64"));
      return { x: 0, y: 0, ...size };
    }
    const client = new AppiumSessionClient(appiumPort, browser.sessionId);
    const original = await client.request<string>("context");
    try {
      await client.request("context", "POST", { name: "NATIVE_APP" });
      const value =
        target.name === "chrome-android"
          ? "//*[contains(@resource-id, ':id/compositor_view_holder')]"
          : "//XCUIElementTypeWebView";
      const element = await client.request<Record<string, string>>("element", "POST", { using: "xpath", value });
      const id = element["element-6066-11e4-a52e-4f735466cecf"] ?? element.ELEMENT;
      if (!id) throw new Error("Appium did not return a WebView element ID.");
      const rect = await client.request<{ x: number; y: number; width: number; height: number }>(
        `element/${encodeURIComponent(id)}/rect`,
      );
      if (target.name !== "chrome-android") return rect;
      const width = Math.min(rect.width, Math.round(browserGeometry.width * browserGeometry.dpr));
      const height = Math.min(rect.height, Math.round(browserGeometry.height * browserGeometry.dpr));
      return { x: rect.x, y: rect.y + rect.height - height, width, height };
    } finally {
      await client.request("context", "POST", { name: original });
    }
  }
}

export class ImageDimensions {
  static png(bytes: Buffer): { width: number; height: number } {
    if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
      throw new Error("Expected a PNG image.");
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
}
