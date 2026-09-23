import { TARGET_NAMES, type TargetConfig, type TargetDefinition, type TargetName } from "./types.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { TestbenchDefaults } from "./defaults.js";

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
      label: "Safari on iOS",
      kind: "mobile",
      supportedPlatforms: ["darwin"],
      serial: true,
    },
    "chrome-android": {
      name: "chrome-android",
      label: "Chrome on Android",
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
    return ["chrome", "firefox", "edge", "chrome-android"];
  }

  static isTargetName(value: string): value is TargetName {
    return TARGET_NAMES.includes(value as TargetName);
  }

  static isSupported(name: TargetName, platform = process.platform): boolean {
    return this.definitions[name].supportedPlatforms.includes(platform);
  }

  static isMobileTargetId(id: string): boolean {
    return TARGET_NAMES.some(
      (name) => this.definitions[name].kind === "mobile" && (id === name || id.startsWith(`${name}-`)),
    );
  }

  static capabilities(target: TargetConfig): Record<string, unknown> {
    const common = target.capabilities ?? {};
    switch (target.name) {
      case "chrome":
        return {
          browserName: "chrome",
          "goog:loggingPrefs": { browser: "ALL", performance: "ALL" },
          "goog:chromeOptions": {
            args: [
              `--remote-allow-origins=${TestbenchDefaults.CHROME_DEVTOOLS_FRONTEND_ORIGIN}`,
              ...(target.headless ? ["--headless=new"] : []),
            ],
            ...(target.downloadDir
              ? { prefs: { "download.default_directory": target.downloadDir, "download.prompt_for_download": false } }
              : {}),
          },
          ...common,
        };
      case "firefox":
        return {
          browserName: "firefox",
          ...((target.headless || target.downloadDir) && {
            "moz:firefoxOptions": {
              ...(target.headless ? { args: ["-headless"] } : {}),
              ...(target.downloadDir
                ? {
                    prefs: {
                      "browser.download.dir": target.downloadDir,
                      "browser.download.folderList": 2,
                      "browser.helperApps.neverAsk.saveToDisk": "application/octet-stream,application/pdf,text/csv",
                    },
                  }
                : {}),
            },
          }),
          ...common,
        };
      case "edge":
        return {
          browserName: "MicrosoftEdge",
          ...((target.headless || target.downloadDir) && {
            "ms:edgeOptions": {
              ...(target.headless ? { args: ["--headless=new"] } : {}),
              ...(target.downloadDir
                ? { prefs: { "download.default_directory": target.downloadDir, "download.prompt_for_download": false } }
                : {}),
            },
          }),
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
          "appium:skipLogCapture": true,
          ...(target.platformVersion ? { "appium:platformVersion": target.platformVersion } : {}),
          ...(target.udid ? { "appium:udid": target.udid } : {}),
          ...(target.deviceKind === "physical" && target.iosTeamId
            ? {
                "appium:xcodeOrgId": target.iosTeamId,
                "appium:xcodeSigningId": target.iosSigningId ?? "Apple Development",
                "appium:updatedWDABundleId": target.wdaBundleId,
                "appium:allowProvisioningDeviceRegistration": true,
                "appium:showXcodeLog": true,
                "appium:wdaLaunchTimeout": TestbenchDefaults.IOS_WDA_LAUNCH_TIMEOUT_MS,
                "appium:wdaStartupRetries": 2,
                "appium:webviewAtomWaitTimeout": TestbenchDefaults.IOS_WEBVIEW_ATOM_TIMEOUT_MS,
                ...(target.initialUrl ? { "appium:initialDeeplinkUrl": target.initialUrl } : {}),
              }
            : {}),
          ...common,
        };
      case "chrome-android":
        return {
          platformName: "Android",
          browserName: "Chrome",
          "appium:automationName": "UiAutomator2",
          "appium:deviceName": target.deviceName ?? "Android Emulator",
          "appium:chromedriverExecutableDir": TestbenchPaths.data("chromedrivers"),
          "appium:adbExecTimeout": TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS,
          "appium:avdLaunchTimeout": TestbenchDefaults.ANDROID_EMULATOR_PHASE_TIMEOUT_MS,
          "appium:avdReadyTimeout": TestbenchDefaults.ANDROID_EMULATOR_PHASE_TIMEOUT_MS,
          "appium:uiautomator2ServerInstallTimeout": TestbenchDefaults.ANDROID_UIAUTOMATOR_INSTALL_TIMEOUT_MS,
          ...(target.platformVersion ? { "appium:platformVersion": target.platformVersion } : {}),
          ...(target.avd ? { "appium:avd": target.avd } : {}),
          ...(target.udid ? { "appium:udid": target.udid } : {}),
          ...common,
        };
    }
  }
}
