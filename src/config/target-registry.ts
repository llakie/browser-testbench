import { TARGET_NAMES, type TargetConfig, type TargetDefinition, type TargetName } from "./types.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

export class TargetRegistry {
  static readonly definitions: Record<TargetName, TargetDefinition> = {
    chrome: {
      name: "chrome",
      label: "Google Chrome",
      kind: "desktop",
      supportedPlatforms: ["darwin", "win32", "linux"],
      serial: false,
    },
    firefox: {
      name: "firefox",
      label: "Mozilla Firefox",
      kind: "desktop",
      supportedPlatforms: ["darwin", "win32", "linux"],
      serial: false,
    },
    safari: {
      name: "safari",
      label: "Apple Safari",
      kind: "desktop",
      supportedPlatforms: ["darwin"],
      serial: true,
    },
    edge: {
      name: "edge",
      label: "Microsoft Edge",
      kind: "desktop",
      supportedPlatforms: ["darwin", "win32", "linux"],
      serial: false,
    },
    "safari-ios": {
      name: "safari-ios",
      label: "Safari im iOS-Simulator",
      kind: "mobile",
      supportedPlatforms: ["darwin"],
      serial: true,
    },
    "chrome-android": {
      name: "chrome-android",
      label: "Chrome im Android-Emulator",
      kind: "mobile",
      supportedPlatforms: ["darwin", "win32", "linux"],
      serial: true,
    },
  };

  static normalize(target: TargetName | TargetConfig): TargetConfig {
    return typeof target === "string" ? { name: target } : { ...target };
  }

  static defaultTargets(platform = process.platform): TargetName[] {
    if (platform === "darwin") return ["chrome", "firefox", "safari", "safari-ios", "chrome-android"];
    if (platform === "win32") return ["chrome", "firefox", "edge", "chrome-android"];
    return ["chrome", "firefox", "chrome-android"];
  }

  static isTargetName(value: string): value is TargetName {
    return TARGET_NAMES.includes(value as TargetName);
  }

  static isSupported(name: TargetName, platform = process.platform): boolean {
    return this.definitions[name].supportedPlatforms.includes(platform);
  }

  static capabilities(target: TargetConfig): Record<string, unknown> {
    const common = target.capabilities ?? {};
    switch (target.name) {
      case "chrome":
        return {
          browserName: "chrome",
          "goog:loggingPrefs": { browser: "ALL", performance: "ALL" },
          ...(target.headless ? { "goog:chromeOptions": { args: ["--headless=new"] } } : {}),
          ...common,
        };
      case "firefox":
        return {
          browserName: "firefox",
          ...(target.headless ? { "moz:firefoxOptions": { args: ["-headless"] } } : {}),
          ...common,
        };
      case "edge":
        return {
          browserName: "MicrosoftEdge",
          ...(target.headless ? { "ms:edgeOptions": { args: ["--headless=new"] } } : {}),
          ...common,
        };
      case "safari":
        return { browserName: "safari", ...common };
      case "safari-ios":
        return {
          platformName: "iOS",
          browserName: "Safari",
          "appium:automationName": "XCUITest",
          "appium:deviceName": target.deviceName ?? "iPhone 16",
          ...(target.platformVersion ? { "appium:platformVersion": target.platformVersion } : {}),
          ...(target.udid ? { "appium:udid": target.udid } : {}),
          ...common,
        };
      case "chrome-android":
        return {
          platformName: "Android",
          browserName: "Chrome",
          "appium:automationName": "UiAutomator2",
          "appium:deviceName": target.deviceName ?? "Android Emulator",
          "appium:chromedriverExecutableDir": TestbenchPaths.cache("chromedrivers"),
          ...(target.platformVersion ? { "appium:platformVersion": target.platformVersion } : {}),
          ...(target.avd ? { "appium:avd": target.avd } : {}),
          ...(target.udid ? { "appium:udid": target.udid } : {}),
          ...common,
        };
    }
  }
}
