import { access } from "node:fs/promises";
import { join } from "node:path";
import { TargetRegistry } from "../config/target-registry.js";
import type { DoctorCheck, TargetName } from "../config/types.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { AndroidDeviceService } from "./android-device-service.js";
import { IosDeviceService } from "./ios-device-service.js";
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
    const supported = this.isNodeSupported();
    const check: DoctorCheck = {
      id: "node",
      label: "Node.js",
      status: supported ? "ready" : "blocked",
      detail: process.version,
    };
    if (!supported) check.action = { key: "environment.nodeUnsupported" };
    return check;
  }

  static isNodeSupported(version = process.versions.node): boolean {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    return (major === 22 && minor >= 12) || major >= 24;
  }

  private static async targetCheck(name: TargetName): Promise<DoctorCheck> {
    const definition = TargetRegistry.definitions[name];
    const label = this.targetLabelMessage(name);
    if (!TargetRegistry.isSupported(name)) {
      return {
        id: name,
        label: label ?? definition.label,
        status: "skip",
        detail: { key: "environment.notAvailablePlatform", parameters: { platform: this.platformLabel() } },
      };
    }

    let check: DoctorCheck;
    switch (name) {
      case "chrome":
        check = await this.applicationCheck(name, definition.label, this.chromePaths());
        break;
      case "firefox":
        check = await this.applicationCheck(name, definition.label, this.firefoxPaths());
        break;
      case "edge":
        check = await this.applicationCheck(name, definition.label, this.edgePaths());
        break;
      case "safari":
        check = await this.safariCheck();
        break;
      case "safari-ios":
        check = await IosDeviceService.inspect();
        break;
      case "chrome-android":
        check = await AndroidDeviceService.inspect();
        break;
    }
    if (label) check.label = label;
    return check;
  }

  private static async applicationCheck(id: string, label: string, paths: string[]): Promise<DoctorCheck> {
    for (const path of paths) {
      if (await this.exists(path)) return { id, label, status: "ready", detail: path };
    }
    return {
      id,
      label,
      status: "blocked",
      detail: { key: "environment.browserNotFound" },
      action: { key: "environment.installProduct", parameters: { product: label } },
    };
  }

  private static async safariCheck(): Promise<DoctorCheck> {
    const binary = "/usr/bin/safaridriver";
    if (!(await this.exists(binary))) {
      return {
        id: "safari",
        label: "Apple Safari",
        status: "blocked",
        detail: { key: "environment.safariNotFound" },
      };
    }
    const verified = await VerificationStore.read("safari");
    if (verified) {
      return {
        id: "safari",
        label: "Apple Safari",
        status: "ready",
        detail: {
          key: "environment.safariVerified",
          parameters: { date: verified.verifiedAt },
          formats: { date: "date" },
        },
      };
    }
    return {
      id: "safari",
      label: "Apple Safari",
      status: "action",
      detail: { key: "environment.safariPermission" },
      action: { key: "environment.safariEnable" },
      commands: ["sudo safaridriver --enable", TestbenchPaths.cliCommand("verify", "safari")],
    };
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

  private static targetLabelMessage(name: TargetName) {
    if (name === "safari-ios") return { key: "environment.safariIosLabel" as const };
    if (name === "chrome-android") return { key: "environment.chromeAndroidLabel" as const };
    return undefined;
  }
}
