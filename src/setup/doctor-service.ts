import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TargetRegistry } from "../config/target-registry.js";
import type { DoctorCheck, TargetDeviceOption, TargetName } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { VerificationStore } from "./verification-store.js";

const APPLICATION_CHECK_TIMEOUT_MS = 5_000;
const DEVICE_LIST_TIMEOUT_MS = 8_000;

export class DoctorService {
  static async inspect(requestedTargets?: TargetName[]): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(await this.nodeCheck());
    const targets = requestedTargets ?? TargetRegistry.defaultTargets();
    for (const target of targets) checks.push(await this.targetCheck(target));
    return checks;
  }

  static hasBlockingChecks(checks: DoctorCheck[]): boolean {
    return checks.some((check) => check.status === "blocked");
  }

  private static async nodeCheck(): Promise<DoctorCheck> {
    const major = Number(process.versions.node.split(".")[0]);
    return {
      id: "node",
      label: "Node.js",
      status: major >= 22 ? "ready" : "blocked",
      detail: process.version,
      ...(major < 22 ? { action: "Install Node.js 22 or newer." } : {}),
    };
  }

  private static async targetCheck(name: TargetName): Promise<DoctorCheck> {
    const definition = TargetRegistry.definitions[name];
    if (!TargetRegistry.isSupported(name)) {
      return {
        id: name,
        label: definition.label,
        status: "skip",
        detail: `Not available on ${this.platformLabel()}.`,
      };
    }

    switch (name) {
      case "chrome":
        return this.applicationCheck(name, definition.label, this.chromePaths());
      case "firefox":
        return this.applicationCheck(name, definition.label, this.firefoxPaths());
      case "edge":
        return this.applicationCheck(name, definition.label, this.edgePaths());
      case "safari":
        return this.safariCheck();
      case "safari-ios":
        return this.iosCheck();
      case "chrome-android":
        return this.androidCheck();
    }
  }

  private static async applicationCheck(id: string, label: string, paths: string[]): Promise<DoctorCheck> {
    for (const path of paths) {
      if (await this.exists(path)) return { id, label, status: "ready", detail: path };
    }
    return {
      id,
      label,
      status: "blocked",
      detail: "Browser not found.",
      action: `Install ${label}.`,
    };
  }

  private static async safariCheck(): Promise<DoctorCheck> {
    const binary = "/usr/bin/safaridriver";
    if (!(await this.exists(binary))) {
      return { id: "safari", label: "Apple Safari", status: "blocked", detail: "Safari WebDriver not found." };
    }
    const verified = await VerificationStore.read("safari");
    if (verified) {
      return {
        id: "safari",
        label: "Apple Safari",
        status: "ready",
        detail: `WebDriver verified on ${this.formatDate(verified.verifiedAt)}.`,
      };
    }
    return {
      id: "safari",
      label: "Apple Safari",
      status: "action",
      detail: "Safari WebDriver is installed. Permission is not checked automatically to avoid opening macOS dialogs.",
      action: "Enable Safari WebDriver once, then verify it for Browser Testbench.",
      commands: ["sudo safaridriver --enable", TestbenchPaths.cliCommand("verify", "safari")],
    };
  }

  private static async iosCheck(): Promise<DoctorCheck> {
    const xcode = await CommandRunner.run("xcodebuild", ["-version"], {
      timeoutMs: APPLICATION_CHECK_TIMEOUT_MS,
    });
    if (xcode.code !== 0) {
      return {
        id: "safari-ios",
        label: TargetRegistry.definitions["safari-ios"].label,
        status: "blocked",
        detail: "Xcode is not available.",
        action: "Install Xcode and select the installation with xcode-select.",
      };
    }
    const runtimes = await CommandRunner.run("xcrun", ["simctl", "list", "runtimes", "--json"], {
      timeoutMs: DEVICE_LIST_TIMEOUT_MS,
    });
    if (runtimes.code !== 0) {
      return {
        id: "safari-ios",
        label: TargetRegistry.definitions["safari-ios"].label,
        status: "blocked",
        detail: "The installed iOS runtimes could not be detected.",
        action: "Open Xcode and install an iOS runtime for the Simulator.",
      };
    }
    const parsed = JSON.parse(runtimes.stdout) as {
      runtimes?: Array<{ isAvailable?: boolean; name?: string; version?: string; identifier?: string }>;
    };
    const available = parsed.runtimes?.filter((runtime) => runtime.isAvailable && runtime.name?.includes("iOS")) ?? [];
    if (available.length === 0) {
      return {
        id: "safari-ios",
        label: TargetRegistry.definitions["safari-ios"].label,
        status: "blocked",
        detail: "No iOS runtime is available.",
        action: "Install an iOS runtime under Xcode > Settings > Components.",
      };
    }
    const devices = await CommandRunner.run("xcrun", ["simctl", "list", "devices", "available", "--json"], {
      timeoutMs: DEVICE_LIST_TIMEOUT_MS,
    });
    const deviceData =
      devices.code === 0
        ? (JSON.parse(devices.stdout) as {
            devices?: Record<string, Array<{ name?: string; udid?: string; isAvailable?: boolean; state?: string }>>;
          })
        : undefined;
    const options = this.iosDeviceOptions(available, deviceData?.devices ?? {});
    if (options.length === 0) {
      return {
        id: "safari-ios",
        label: TargetRegistry.definitions["safari-ios"].label,
        status: "blocked",
        detail: `${available.map((runtime) => runtime.name).join(", ")} installed, but no available simulator was found.`,
        action: "Create an iOS Simulator under Xcode > Window > Devices and Simulators.",
      };
    }
    return {
      id: "safari-ios",
      label: TargetRegistry.definitions["safari-ios"].label,
      status: "ready",
      detail: `${options.length} iOS ${options.length === 1 ? "Simulator is" : "Simulators are"} available.`,
      devices: options,
    };
  }

  static iosDeviceOptions(
    runtimes: Array<{ name?: string; version?: string; identifier?: string }>,
    devices: Record<string, Array<{ name?: string; udid?: string; isAvailable?: boolean; state?: string }>>,
  ): TargetDeviceOption[] {
    const versions = new Map(
      runtimes.filter((runtime) => runtime.identifier).map((runtime) => [runtime.identifier!, runtime.version]),
    );
    return Object.entries(devices).flatMap(([runtimeId, entries]) => {
      const platformVersion = versions.get(runtimeId);
      if (!versions.has(runtimeId)) return [];
      return entries
        .filter((device) => device.isAvailable !== false && device.name && device.udid)
        .map((device) => ({
          id: device.udid!,
          name: device.name!,
          platformVersion,
          state: device.state,
          compatible: true,
          config: {
            name: "safari-ios" as const,
            deviceName: device.name!,
            ...(platformVersion ? { platformVersion } : {}),
            udid: device.udid!,
          },
        }));
    });
  }

  private static async androidCheck(): Promise<DoctorCheck> {
    const sdkRoot = await this.androidSdkRoot();
    if (!sdkRoot) {
      return {
        id: "chrome-android",
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "blocked",
        detail: "Android SDK not found.",
        action: "Install Android Studio or set the ANDROID_HOME environment variable.",
      };
    }
    const emulator = join(sdkRoot, "emulator", AndroidSdk.executableName("emulator"));
    if (!(await this.exists(emulator))) {
      return {
        id: "chrome-android",
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "blocked",
        detail: "Android Emulator not found.",
        action: "Install Android Emulator through the SDK Manager.",
      };
    }
    const avds = await CommandRunner.run(emulator, ["-list-avds"], { timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    const names = avds.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length === 0) {
      return {
        id: "chrome-android",
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "blocked",
        detail: "No Android Virtual Device (AVD) found.",
        action: "Create an AVD with Google APIs or the Google Play Store in Android Studio.",
      };
    }
    const options = await this.androidDeviceOptions(names);
    const chromeCapable = options.filter((option) => option.compatible);
    if (chromeCapable.length === 0) {
      return {
        id: "chrome-android",
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "action",
        detail: `AVDs found (${names.join(", ")}), but none uses a Google Play system image.`,
        action: "Create an AVD with a Google Play system image.",
        devices: options,
      };
    }
    return {
      id: "chrome-android",
      label: TargetRegistry.definitions["chrome-android"].label,
      status: "ready",
      detail: `${chromeCapable.length} of ${options.length} Android virtual ${options.length === 1 ? "device is" : "devices are"} compatible with Chrome.`,
      devices: options,
    };
  }

  static async androidSdkRoot(): Promise<string | undefined> {
    return AndroidSdk.root();
  }

  static async androidDeviceOptions(names: string[]): Promise<TargetDeviceOption[]> {
    const avdHome =
      process.env.ANDROID_AVD_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".android", "avd");
    const options: TargetDeviceOption[] = [];
    for (const name of names) {
      const pointer = join(avdHome, `${name}.ini`);
      try {
        const pointerText = await readFile(pointer, "utf8");
        const path = pointerText.match(/^path=(.+)$/m)?.[1];
        if (!path) continue;
        const config = await readFile(join(path, "config.ini"), "utf8");
        const image = config.match(/^image\.sysdir\.1=(.+)$/m)?.[1];
        const platformVersion = image?.match(/android-([^/]+)/)?.[1];
        options.push({
          id: name,
          name,
          platformVersion,
          compatible: /^tag\.id=google_apis_playstore(?:_|$)/m.test(config),
          config: { name: "chrome-android", avd: name, ...(platformVersion ? { platformVersion } : {}) },
        });
      } catch {
        // Ignore malformed or externally managed AVD entries.
      }
    }
    return options;
  }

  private static chromePaths(): string[] {
    if (process.platform === "darwin") return ["/Applications/Google Chrome.app"];
    if (process.platform === "win32")
      return [
        join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ];
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
  }

  private static firefoxPaths(): string[] {
    if (process.platform === "darwin") return ["/Applications/Firefox.app"];
    if (process.platform === "win32")
      return [
        join(process.env.PROGRAMFILES ?? "", "Mozilla Firefox", "firefox.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Mozilla Firefox", "firefox.exe"),
      ];
    return ["/usr/bin/firefox", "/snap/bin/firefox"];
  }

  private static edgePaths(): string[] {
    if (process.platform === "darwin") return ["/Applications/Microsoft Edge.app"];
    if (process.platform === "win32")
      return [
        join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
      ];
    return ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"];
  }

  private static async exists(path: string): Promise<boolean> {
    if (!path) return false;
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private static platformLabel(): string {
    if (process.platform === "darwin") return "macOS";
    if (process.platform === "win32") return "Windows";
    return "Linux";
  }

  private static formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
}
