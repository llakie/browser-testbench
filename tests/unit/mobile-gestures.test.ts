import { describe, expect, it, vi } from "vitest";
import { MobileGestures } from "../../src/automation/mobile-gestures.js";
import type { BrowserHandle } from "../../src/automation/browser-session.js";

const area = { left: 10, top: 20, width: 300, height: 600 };

describe("MobileGestures", () => {
  it("maps taps to the native command of each platform", () => {
    expect(MobileGestures.commandFor("safari-ios", { type: "tap", x: 40, y: 80 })).toMatchObject({
      command: "mobile: tap",
      parameters: { x: 40, y: 80 },
    });
    expect(MobileGestures.commandFor("chrome-android", { type: "tap", x: 40, y: 80 })).toMatchObject({
      command: "mobile: clickGesture",
      parameters: { x: 40, y: 80 },
    });
  });

  it("maps swipes to iOS velocity and Android bounded-percent arguments", () => {
    expect(
      MobileGestures.commandFor("safari-ios", {
        type: "swipe",
        direction: "up",
        percent: 0.75,
        velocity: 900,
      }),
    ).toMatchObject({ command: "mobile: swipe", parameters: { direction: "up", velocity: 900 } });
    expect(
      MobileGestures.commandFor(
        "chrome-android",
        { type: "swipe", direction: "left", percent: 0.6, speed: 1_200 },
        area,
      ),
    ).toMatchObject({
      command: "mobile: swipeGesture",
      parameters: { ...area, direction: "left", percent: 0.6, speed: 1_200 },
    });
  });

  it("maps pinch direction to each platform's native scale model", () => {
    expect(
      MobileGestures.commandFor("safari-ios", {
        type: "pinch",
        direction: "out",
        percent: 0.4,
        velocity: 1.5,
      }),
    ).toMatchObject({ command: "mobile: pinch", parameters: { scale: 1.4, velocity: 1.5 } });
    expect(
      MobileGestures.commandFor("chrome-android", { type: "pinch", direction: "in", percent: 0.4, velocity: 1 }, area),
    ).toMatchObject({ command: "mobile: pinchCloseGesture", parameters: { ...area, percent: 0.4 } });
  });

  it("validates suite inputs, applies defaults, and dispatches through Selenium", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const getWindowRect = vi.fn().mockResolvedValue({ x: 0, y: 10, width: 390, height: 760 });
    const browser = { execute, getWindowRect } as unknown as BrowserHandle;

    const execution = await MobileGestures.perform(
      browser,
      { name: "chrome-android" },
      {
        type: "swipe",
        direction: "up",
      },
    );

    expect(execution.parameters).toMatchObject({ left: 0, top: 10, width: 390, height: 760, percent: 0.75 });
    expect(execute).toHaveBeenCalledWith("mobile: swipeGesture", execution.parameters);
  });

  it("rejects touch gestures for desktop targets", async () => {
    await expect(
      MobileGestures.perform({} as BrowserHandle, { name: "chrome" }, { type: "tap", x: 1, y: 1 }),
    ).rejects.toThrow("desktop target");
  });
});
