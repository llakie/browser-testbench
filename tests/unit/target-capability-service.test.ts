import { describe, expect, it } from "vitest";
import { TargetCapabilityService } from "../../src/setup/target-capability-service.js";

describe("TargetCapabilityService", () => {
  const android = TargetCapabilityService.for({
    browser: "chrome-android",
    kind: "mobile",
    deviceKind: "emulator",
  });

  it("describes target features and server limits without starting a target", () => {
    expect(android).toMatchObject({
      localOrigins: { reverse: true },
      permissions: { native: ["camera", "microphone"] },
      mediaInjection: { cameraImage: true },
      recording: { screen: true, marks: true },
      screenshots: { viewport: true, element: true },
    });
    expect(android.limits.assetBytes).toBeGreaterThanOrEqual(25 * 1024 * 1024);
  });

  it("reports every missing nested capability", () => {
    expect(
      TargetCapabilityService.missing(
        { recording: { viewport: true, pauseResume: true }, permissions: { native: ["camera", "notifications"] } },
        android,
      ),
    ).toEqual(["recording.viewport", "recording.pauseResume", "permissions.native"]);
  });
});
