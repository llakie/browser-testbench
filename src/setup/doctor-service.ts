import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TargetRegistry } from "../config/target-registry.js";
import type { DoctorCheck, TargetName } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { VerificationStore } from "./verification-store.js";

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
      return { id: name, label: definition.label, status: "skip", detail: `Not supported on ${process.platform}.` };
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
    return { id, label, status: "blocked", detail: "Browser not found.", action: `Install ${label}.` };
  }

  private static async safariCheck(): Promise<DoctorCheck> {
    const binary = "/usr/bin/safaridriver";
    if (!(await this.exists(binary))) {
      return { id: "safari", label: "Apple Safari", status: "blocked", detail: "safaridriver not found." };
    }
    const verified = await VerificationStore.read("safari");
    if (verified) {
      return { id: "safari", label: "Apple Safari", status: "ready", detail: `Verified ${verified.verifiedAt}.` };
    }
    return {
      id: "safari",
      label: "Apple Safari",
      status: "action",
      detail: "safaridriver is installed; authorization is intentionally not probed to avoid macOS dialogs.",
      action: "Once only, run 'sudo safaridriver --enable', then verify with 'btb verify safari'.",
    };
  }

  private static async iosCheck(): Promise<DoctorCheck> {
    const xcode = await CommandRunner.run("xcodebuild", ["-version"], { timeoutMs: 5_000 });
    if (xcode.code !== 0) {
      return {
        id: "safari-ios",
        label: "Safari on iOS Simulator",
        status: "blocked",
        detail: "Xcode is not available.",
        action: "Install Xcode and select it with xcode-select.",
      };
    }
    const runtimes = await CommandRunner.run("xcrun", ["simctl", "list", "runtimes", "--json"], { timeoutMs: 8_000 });
    if (runtimes.code !== 0) {
      return {
        id: "safari-ios",
        label: "Safari on iOS Simulator",
        status: "blocked",
        detail: "simctl could not list runtimes.",
        action: "Open Xcode and install an iOS Simulator runtime.",
      };
    }
    const parsed = JSON.parse(runtimes.stdout) as { runtimes?: Array<{ isAvailable?: boolean; name?: string }> };
    const available = parsed.runtimes?.find((runtime) => runtime.isAvailable && runtime.name?.includes("iOS"));
    if (!available) {
      return {
        id: "safari-ios",
        label: "Safari on iOS Simulator",
        status: "blocked",
        detail: "No available iOS runtime.",
        action: "Install an iOS runtime in Xcode Settings > Components.",
      };
    }
    const devices = await CommandRunner.run("xcrun", ["simctl", "list", "devices", "available", "--json"], {
      timeoutMs: 8_000,
    });
    const deviceData =
      devices.code === 0
        ? (JSON.parse(devices.stdout) as { devices?: Record<string, Array<{ name?: string; isAvailable?: boolean }>> })
        : undefined;
    const phone = Object.values(deviceData?.devices ?? {})
      .flat()
      .find((device) => device.isAvailable !== false && device.name?.startsWith("iPhone"));
    if (!phone) {
      return {
        id: "safari-ios",
        label: "Safari on iOS Simulator",
        status: "blocked",
        detail: `${available.name ?? "iOS runtime"} exists, but no available iPhone Simulator was found.`,
        action: "Create an iPhone Simulator in Xcode > Window > Devices and Simulators.",
      };
    }
    return {
      id: "safari-ios",
      label: "Safari on iOS Simulator",
      status: "ready",
      detail: `${available.name ?? "iOS runtime"}; ${phone.name}`,
    };
  }

  private static async androidCheck(): Promise<DoctorCheck> {
    const sdkRoot = await this.androidSdkRoot();
    if (!sdkRoot) {
      return {
        id: "chrome-android",
        label: "Chrome on Android Emulator",
        status: "blocked",
        detail: "Android SDK not found.",
        action: "Install Android Studio or set ANDROID_HOME.",
      };
    }
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    if (!(await this.exists(emulator))) {
      return {
        id: "chrome-android",
        label: "Chrome on Android Emulator",
        status: "blocked",
        detail: "Android emulator binary not found.",
        action: "Install Android Emulator from the SDK Manager.",
      };
    }
    const avds = await CommandRunner.run(emulator, ["-list-avds"], { timeoutMs: 8_000 });
    const names = avds.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length === 0) {
      return {
        id: "chrome-android",
        label: "Chrome on Android Emulator",
        status: "blocked",
        detail: "No Android Virtual Device found.",
        action: "Create a Google APIs or Play Store AVD in Android Studio.",
      };
    }
    const chromeCapable = await this.findChromeCapableAvd(names);
    if (!chromeCapable) {
      return {
        id: "chrome-android",
        label: "Chrome on Android Emulator",
        status: "action",
        detail: `AVDs found (${names.join(", ")}), but none is identified as a Google APIs/Play Store image.`,
        action: "Create an AVD using a Google APIs or Google Play system image.",
      };
    }
    return {
      id: "chrome-android",
      label: "Chrome on Android Emulator",
      status: "ready",
      detail: `${chromeCapable} (${sdkRoot})`,
    };
  }

  static async androidSdkRoot(): Promise<string | undefined> {
    const candidates = [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      process.platform === "darwin" ? join(process.env.HOME ?? "", "Library", "Android", "sdk") : undefined,
      process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : undefined,
    ].filter((value): value is string => Boolean(value));
    for (const path of candidates) if (await this.exists(path)) return path;
    return undefined;
  }

  private static async findChromeCapableAvd(names: string[]): Promise<string | undefined> {
    const avdHome =
      process.env.ANDROID_AVD_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".android", "avd");
    for (const name of names) {
      const pointer = join(avdHome, `${name}.ini`);
      try {
        const pointerText = await readFile(pointer, "utf8");
        const path = pointerText.match(/^path=(.+)$/m)?.[1];
        if (!path) continue;
        const config = await readFile(join(path, "config.ini"), "utf8");
        if (/tag\.id=google_apis_playstore/.test(config)) return name;
      } catch {
        // Ignore malformed or externally managed AVD entries.
      }
    }
    return undefined;
  }

  private static chromePaths(): string[] {
    if (process.platform === "darwin") return ["/Applications/Google Chrome.app"];
    if (process.platform === "win32")
      return [
        join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ];
    return ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  }

  private static firefoxPaths(): string[] {
    if (process.platform === "darwin") return ["/Applications/Firefox.app"];
    if (process.platform === "win32")
      return [
        join(process.env.PROGRAMFILES ?? "", "Mozilla Firefox", "firefox.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Mozilla Firefox", "firefox.exe"),
      ];
    return ["/usr/bin/firefox"];
  }

  private static edgePaths(): string[] {
    if (process.platform === "darwin") return ["/Applications/Microsoft Edge.app"];
    if (process.platform === "win32")
      return [
        join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
      ];
    return ["/usr/bin/microsoft-edge"];
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
}
