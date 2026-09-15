import { describe, expect, it } from "vitest";
import { BrowserSession } from "../../src/automation/browser-session.js";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TestbenchPaths } from "../../src/infrastructure/paths.js";

describe("TargetRegistry", () => {
  it("provides a CLI command using the canonical executable", () => {
    const command = TestbenchPaths.cliCommand("doctor");
    expect(command).toContain("dist/cli.js");
    expect(command).toContain("doctor");
    expect(command).toContain("dist/cli.js");
  });
  it("uses branded desktop browser capabilities", () => {
    expect(TargetRegistry.capabilities({ name: "chrome" })).toMatchObject({ browserName: "chrome" });
    expect(TargetRegistry.capabilities({ name: "firefox" })).toMatchObject({ browserName: "firefox" });
    expect(TargetRegistry.capabilities({ name: "safari" })).toMatchObject({ browserName: "safari" });
    expect(TargetRegistry.capabilities({ name: "edge" })).toMatchObject({ browserName: "MicrosoftEdge" });
  });

  it("builds Appium web capabilities for both simulators", () => {
    expect(
      TargetRegistry.capabilities({ name: "safari-ios", deviceName: "iPhone 17", udid: "SIMULATOR-ID" }),
    ).toMatchObject({
      platformName: "iOS",
      browserName: "Safari",
      "appium:automationName": "XCUITest",
      "appium:deviceName": "iPhone 17",
      "appium:udid": "SIMULATOR-ID",
    });
    expect(TargetRegistry.capabilities({ name: "chrome-android", avd: "Pixel_Test" })).toMatchObject({
      platformName: "Android",
      browserName: "Chrome",
      "appium:automationName": "UiAutomator2",
      "appium:avd": "Pixel_Test",
    });
  });

  it("maps host-local URLs for Android Emulator networking", () => {
    expect(BrowserSession.urlForTarget("http://localhost:3000/path", { name: "chrome-android" })).toBe(
      "http://10.0.2.2:3000/path",
    );
    expect(BrowserSession.urlForTarget("https://example.com", { name: "chrome-android" })).toBe("https://example.com/");
  });

  it("selects platform-specific defaults without unsupported Apple targets on Windows", () => {
    expect(TargetRegistry.defaultTargets("win32")).toEqual(["chrome", "firefox", "edge", "chrome-android"]);
  });
});
