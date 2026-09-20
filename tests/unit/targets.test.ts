import { describe, expect, it } from "vitest";
import { BrowserSession } from "../../src/automation/browser-session.js";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TestbenchPaths } from "../../src/infrastructure/paths.js";

describe("TargetRegistry", () => {
  it("provides a CLI command using the canonical executable", () => {
    const command = TestbenchPaths.cliCommand("doctor");
    expect(command).toBe("browser-testbench doctor");
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
      "appium:skipLogCapture": true,
      "appium:udid": "SIMULATOR-ID",
    });
    expect(TargetRegistry.capabilities({ name: "chrome-android", avd: "Pixel_Test" })).toMatchObject({
      platformName: "Android",
      browserName: "Chrome",
      "appium:automationName": "UiAutomator2",
      "appium:avd": "Pixel_Test",
      "appium:adbExecTimeout": 120_000,
      "appium:avdLaunchTimeout": 180_000,
      "appium:avdReadyTimeout": 180_000,
      "appium:uiautomator2ServerInstallTimeout": 120_000,
    });
    expect(
      TargetRegistry.capabilities({
        name: "chrome-android",
        deviceKind: "physical",
        deviceName: "Pixel 8",
        platformVersion: "16",
        udid: "R5CT1234",
      }),
    ).toMatchObject({
      platformName: "Android",
      browserName: "Chrome",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Pixel 8",
      "appium:platformVersion": "16",
      "appium:udid": "R5CT1234",
    });

    expect(
      TargetRegistry.capabilities({
        name: "safari-ios",
        deviceKind: "physical",
        deviceName: "iPhone 17 Pro",
        platformVersion: "26.0",
        udid: "00008140-DEVICE",
        iosTeamId: "A1B2C3D4E5",
        iosSigningId: "Apple Development",
        wdaBundleId: "com.browser-testbench.WebDriverAgentRunner.a1b2c3d4e5",
        initialUrl: "https://example.com",
      }),
    ).toMatchObject({
      platformName: "iOS",
      browserName: "Safari",
      "appium:udid": "00008140-DEVICE",
      "appium:xcodeOrgId": "A1B2C3D4E5",
      "appium:xcodeSigningId": "Apple Development",
      "appium:updatedWDABundleId": "com.browser-testbench.WebDriverAgentRunner.a1b2c3d4e5",
      "appium:allowProvisioningDeviceRegistration": true,
      "appium:showXcodeLog": true,
      "appium:wdaLaunchTimeout": 120_000,
      "appium:webviewAtomWaitTimeout": 30_000,
      "appium:initialDeeplinkUrl": "https://example.com",
    });
  });

  it("maps host-local URLs for Android Emulator networking", () => {
    expect(BrowserSession.urlForTarget("http://localhost:3000/path", { name: "chrome-android" })).toBe(
      "http://10.0.2.2:3000/path",
    );
    expect(BrowserSession.urlForTarget("https://example.com", { name: "chrome-android" })).toBe("https://example.com/");
    expect(
      BrowserSession.urlForTarget("http://localhost:3000/path", {
        name: "chrome-android",
        deviceKind: "physical",
        udid: "R5CT1234",
      }),
    ).toBe("http://localhost:3000/path");
  });

  it("selects platform-specific defaults without unsupported Apple targets on Windows", () => {
    expect(TargetRegistry.defaultTargets("win32")).toEqual(["chrome", "firefox", "edge", "chrome-android"]);
  });

  it("recognizes generated mobile target IDs", () => {
    expect(TargetRegistry.isMobileTargetId("chrome-android-pixel-8-16")).toBe(true);
    expect(TargetRegistry.isMobileTargetId("safari-ios-iphone-17-pro-26-5")).toBe(true);
    expect(TargetRegistry.isMobileTargetId("chrome")).toBe(false);
  });

  it("includes all supported non-Apple targets on Linux", () => {
    expect(TargetRegistry.defaultTargets("linux")).toEqual(["chrome", "firefox", "edge", "chrome-android"]);
    expect(TargetRegistry.isSupported("chrome-android", "linux")).toBe(true);
    expect(TargetRegistry.isSupported("safari-ios", "linux")).toBe(false);
  });
});
