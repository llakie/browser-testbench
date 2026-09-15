import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TargetRegistry } from "../config/target-registry.js";
import type { DoctorCheck, TargetDeviceOption, TargetName } from "../config/types.js";
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
      ...(major < 22 ? { action: "Installiere Node.js 22 oder neuer." } : {}),
    };
  }

  private static async targetCheck(name: TargetName): Promise<DoctorCheck> {
    const definition = TargetRegistry.definitions[name];
    if (!TargetRegistry.isSupported(name)) {
      return {
        id: name,
        label: definition.label,
        status: "skip",
        detail: `Auf ${this.platformLabel()} nicht verfügbar.`,
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
      detail: "Browser nicht gefunden.",
      action: `Installiere ${label}.`,
    };
  }

  private static async safariCheck(): Promise<DoctorCheck> {
    const binary = "/usr/bin/safaridriver";
    if (!(await this.exists(binary))) {
      return { id: "safari", label: "Apple Safari", status: "blocked", detail: "Safari WebDriver nicht gefunden." };
    }
    const verified = await VerificationStore.read("safari");
    if (verified) {
      return {
        id: "safari",
        label: "Apple Safari",
        status: "ready",
        detail: `WebDriver am ${this.formatDate(verified.verifiedAt)} bestätigt.`,
      };
    }
    return {
      id: "safari",
      label: "Apple Safari",
      status: "action",
      detail:
        "Safari WebDriver ist installiert. Die Berechtigung wird nicht automatisch geprüft, damit macOS keine Dialoge öffnet.",
      action: "Aktiviere Safari WebDriver einmalig und bestätige ihn anschließend für die Testbench.",
      commands: ["sudo safaridriver --enable", TestbenchPaths.cliCommand("verify", "safari")],
    };
  }

  private static async iosCheck(): Promise<DoctorCheck> {
    const xcode = await CommandRunner.run("xcodebuild", ["-version"], { timeoutMs: 5_000 });
    if (xcode.code !== 0) {
      return {
        id: "safari-ios",
        label: TargetRegistry.definitions["safari-ios"].label,
        status: "blocked",
        detail: "Xcode ist nicht verfügbar.",
        action: "Installiere Xcode und wähle die Installation mit xcode-select aus.",
      };
    }
    const runtimes = await CommandRunner.run("xcrun", ["simctl", "list", "runtimes", "--json"], { timeoutMs: 8_000 });
    if (runtimes.code !== 0) {
      return {
        id: "safari-ios",
        label: TargetRegistry.definitions["safari-ios"].label,
        status: "blocked",
        detail: "Die installierten iOS-Laufzeitumgebungen konnten nicht ermittelt werden.",
        action: "Öffne Xcode und installiere eine iOS-Laufzeitumgebung für den Simulator.",
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
        detail: "Keine iOS-Laufzeitumgebung verfügbar.",
        action: "Installiere eine iOS-Laufzeitumgebung unter Xcode > Einstellungen > Komponenten.",
      };
    }
    const devices = await CommandRunner.run("xcrun", ["simctl", "list", "devices", "available", "--json"], {
      timeoutMs: 8_000,
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
        detail: `${available.map((runtime) => runtime.name).join(", ")} vorhanden, aber kein verfügbarer Simulator gefunden.`,
        action: "Lege unter Xcode > Fenster > Geräte und Simulatoren einen iOS-Simulator an.",
      };
    }
    return {
      id: "safari-ios",
      label: TargetRegistry.definitions["safari-ios"].label,
      status: "ready",
      detail: `${options.length} ${options.length === 1 ? "iOS-Simulator ist" : "iOS-Simulatoren sind"} verfügbar.`,
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
        detail: "Android SDK nicht gefunden.",
        action: "Installiere Android Studio oder setze die Umgebungsvariable ANDROID_HOME.",
      };
    }
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    if (!(await this.exists(emulator))) {
      return {
        id: "chrome-android",
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "blocked",
        detail: "Android Emulator nicht gefunden.",
        action: "Installiere Android Emulator über den SDK Manager.",
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
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "blocked",
        detail: "Kein virtuelles Android-Gerät (AVD) gefunden.",
        action: "Lege in Android Studio ein AVD mit Google APIs oder Google Play Store an.",
      };
    }
    const options = await this.androidDeviceOptions(names);
    const chromeCapable = options.filter((option) => option.compatible);
    if (chromeCapable.length === 0) {
      return {
        id: "chrome-android",
        label: TargetRegistry.definitions["chrome-android"].label,
        status: "action",
        detail: `AVDs gefunden (${names.join(", ")}), aber keines verwendet ein Google-APIs-/Play-Store-Abbild.`,
        action: "Lege ein AVD mit einem Systemabbild für Google APIs oder Google Play Store an.",
        devices: options,
      };
    }
    return {
      id: "chrome-android",
      label: TargetRegistry.definitions["chrome-android"].label,
      status: "ready",
      detail: `${chromeCapable.length} von ${options.length} ${options.length === 1 ? "virtuellem Android-Gerät ist" : "virtuellen Android-Geräten sind"} für Chrome geeignet.`,
      devices: options,
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
          compatible: /^tag\.id=google_apis_playstore/m.test(config),
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

  private static platformLabel(): string {
    if (process.platform === "darwin") return "macOS";
    if (process.platform === "win32") return "Windows";
    return "Linux";
  }

  private static formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
}
