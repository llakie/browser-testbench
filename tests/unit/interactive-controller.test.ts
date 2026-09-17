import { describe, expect, it } from "vitest";
import { InteractiveController } from "../../src/automation/interactive-controller.js";

describe("InteractiveController", () => {
  it("rejects unsupported Android full-page screenshots explicitly", async () => {
    const controller = new InteractiveController();
    Object.assign(controller, { target: { name: "chrome-android" } });

    await expect(controller.captureScreenshot(true)).rejects.toThrow(
      "Full-page screenshots are not supported by Chrome on Android",
    );
  });
});
