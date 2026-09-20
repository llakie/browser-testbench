import { describe, expect, it } from "vitest";
import { IosPhysicalStartupError } from "../../src/automation/ios-physical-startup-error.js";
import type { TargetConfig } from "../../src/config/types.js";

const target: TargetConfig = {
  name: "safari-ios",
  deviceKind: "physical",
  deviceName: "iPhone X",
  platformVersion: "16.7.11",
  wdaBundleId: "com.browser-testbench.WebDriverAgentRunner.team",
};

describe("IosPhysicalStartupError", () => {
  it("distinguishes a blocked Safari debugger from signing failures", () => {
    const result = IosPhysicalStartupError.from(
      new Error("The remote Safari debugger did not respond to the requested command after 30000ms."),
      target,
    );

    expect((result as Error).message).toContain("Web Inspector did not respond");
    expect((result as Error).message).not.toContain("could not be signed");
  });

  it("recognizes terminal Xcode diagnostics", () => {
    expect(IosPhysicalStartupError.hasTerminalDiagnostic("profile has not been explicitly trusted by the user")).toBe(
      true,
    );
    expect(IosPhysicalStartupError.hasTerminalDiagnostic("Waiting for WebDriverAgent")).toBe(false);
  });

  it("reports a developer profile that still needs trust on the device", () => {
    const original = new Error("Unable to start WebDriverAgent session. Original error: socket hang up");
    const result = IosPhysicalStartupError.from(
      original,
      target,
      "Unable to launch because its profile has not been explicitly trusted by the user",
    );

    expect((result as Error).message).toContain("built, signed, and installed");
    expect((result as Error).message).toContain("Settings → General → VPN & Device Management");
    expect((result as Error).message).toContain("choose Trust");
  });

  it("reports an occupied WebDriverAgent port instead of a signing failure", () => {
    const result = IosPhysicalStartupError.from(new Error("The port #8100 is occupied by another process"), target);

    expect((result as Error).message).toContain("port 8100 is still used by another process");
    expect((result as Error).message).toContain("This is not a signing failure");
  });

  it("reports a missing Xcode platform component instead of a signing failure", () => {
    const original = new Error("Unable to start WebDriverAgent session. Original error: socket hang up");
    const result = IosPhysicalStartupError.from(
      original,
      target,
      "iPhone X, error:iOS 26.2 is not installed. Please download and install the platform from Xcode → Settings → Components.",
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("iOS 26.2 platform component is not installed");
    expect((result as Error).message).toContain("Xcode → Settings → Components");
    expect((result as Error).message).toContain("This is not a signing failure");
  });

  it("reports an Xcode and iOS compatibility failure instead of a signing failure", () => {
    const original = new Error("Unable to start WebDriverAgent session. Original error: socket hang up");
    const result = IosPhysicalStartupError.from(
      original,
      target,
      "Cannot test target WebDriverAgentRunner: Logic Testing Unavailable",
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("This is an Xcode compatibility problem, not a signing failure");
    expect((result as Error).message).toContain("select Xcode 26.2");
  });

  it("keeps the signing guidance for genuine WebDriverAgent provisioning failures", () => {
    const result = IosPhysicalStartupError.from(new Error("xcodebuild failed: No provisioning profile found"), target);

    expect((result as Error).message).toContain("WebDriverAgent could not be signed or installed");
    expect((result as Error).message).toContain(target.wdaBundleId);
  });

  it("does not rewrite unrelated failures", () => {
    const original = new Error("Safari navigation failed");

    expect(IosPhysicalStartupError.from(original, target)).toBe(original);
  });

  it("does not infer a signing failure from routine WebDriverAgent output", () => {
    const original = new Error("Safari did not open 'collectile.com'.");

    expect(IosPhysicalStartupError.from(original, target, "WebDriverAgent started successfully")).toBe(original);
  });

  it("does not infer a signing failure from a successful codesign command in the Appium log", () => {
    const original = new Error("Safari navigation failed");

    expect(IosPhysicalStartupError.from(original, target, "/usr/bin/codesign WebDriverAgentRunner")).toBe(original);
  });

  it("keeps version-specific Xcode guidance limited to iOS 16", () => {
    const result = IosPhysicalStartupError.from(
      new Error("Unable to start WebDriverAgent"),
      { ...target, platformVersion: "26.5" },
      "Logic Testing Unavailable",
    );

    expect((result as Error).message).toContain("supports the connected iOS version");
    expect((result as Error).message).not.toContain("Xcode 26.2");
  });
});
