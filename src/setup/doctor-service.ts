import { access } from "node:fs/promises";
import { join } from "node:path";
import { TargetRegistry } from "../config/target-registry.js";
import type { DoctorCheck, TargetDeviceOption, TargetName } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { AndroidDeviceService } from "./android-device-service.js";
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
    const supported = this.isNodeSupported();
    return {
      id: "node",
      label: "Node.js",
      status: supported ? "ready" : "blocked",
      detail: process.version,
      ...(!supported ? { action: "Install Node.js 22.12 LTS or Node.js 24 or newer." } : {}),
    };
  }

  static isNodeSupported(version = process.versions.node): boolean {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    return (major === 22 && minor >= 12) || major >= 24;
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
        return AndroidDeviceService.inspect();
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
          deviceKind: "simulator" as const,
          compatible: true,
          config: {
            name: "safari-ios" as const,
            deviceKind: "simulator" as const,
            deviceName: device.name!,
            ...(platformVersion ? { platformVersion } : {}),
            udid: device.udid!,
          },
        }));
    });
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
