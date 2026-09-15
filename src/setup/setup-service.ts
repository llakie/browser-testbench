import { access, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TargetName } from "../config/types.js";
import { TargetRegistry } from "../config/target-registry.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { DoctorService } from "./doctor-service.js";

export interface SetupAction {
  label: string;
  command?: string;
  automatic: boolean;
  status: "planned" | "completed" | "failed" | "manual";
  detail?: string;
}

export interface AppiumDriverStatus {
  name: "xcuitest" | "uiautomator2";
  installed: boolean;
  version?: string;
}

export class SetupService {
  static async plan(targets: TargetName[]): Promise<SetupAction[]> {
    targets = targets.filter((target) => TargetRegistry.isSupported(target));
    const actions: SetupAction[] = [];
    const mobileTargets = targets.filter((target) => target === "safari-ios" || target === "chrome-android");
    if (mobileTargets.length > 0) {
      const statuses = await this.appiumDriverStatus(mobileTargets);
      for (const driver of statuses) {
        actions.push({
          label: `Appium ${this.driverLabel(driver.name)}`,
          command: driver.installed
            ? undefined
            : TestbenchPaths.cliCommand("setup", "--yes", "--targets", mobileTargets.join(",")),
          automatic: true,
          status: driver.installed ? "completed" : "planned",
          detail: driver.installed
            ? `Version ${driver.version ?? "unbekannt"} ist lokal installiert.`
            : "Treiber ist noch nicht installiert.",
        });
      }
    }
    const checks = await DoctorService.inspect(targets);
    for (const check of checks.filter((entry) => entry.status === "blocked" || entry.status === "action")) {
      if (check.action && !actions.some((action) => action.label === check.label)) {
        actions.push({
          label: check.label,
          automatic: false,
          status: "manual",
          detail: check.action,
          command: check.commands?.[0],
        });
      }
    }
    return actions;
  }

  static async install(
    targets: TargetName[],
    options: { androidAvdName?: string; onOutput?: (line: string) => void } = {},
  ): Promise<SetupAction[]> {
    targets = targets.filter((target) => TargetRegistry.isSupported(target));
    const results: SetupAction[] = [];
    const mobileTargets = targets.filter((target) => target === "safari-ios" || target === "chrome-android");
    if (mobileTargets.length > 0) {
      const appiumHome = TestbenchPaths.cache("appium");
      await mkdir(appiumHome, { recursive: true });
      const existingDrivers = new Map(
        (await this.appiumDriverStatus(mobileTargets)).map((driver) => [driver.name, driver]),
      );
      for (const target of mobileTargets) {
        const driver = target === "safari-ios" ? "xcuitest" : "uiautomator2";
        const existing = existingDrivers.get(driver);
        if (existing?.installed) {
          results.push({
            label: `Appium ${this.driverLabel(driver)}`,
            automatic: true,
            status: "completed",
            detail: `Version ${existing.version ?? "unbekannt"} ist bereits lokal installiert.`,
          });
          continue;
        }
        options.onOutput?.(`Appium-Treiber ${driver} wird installiert …`);
        const installation = await CommandRunner.run(
          TestbenchPaths.localBinary("appium"),
          ["driver", "install", driver],
          {
            env: { ...process.env, APPIUM_HOME: appiumHome },
            timeoutMs: 600_000,
          },
        );
        results.push({
          label: `Appium ${this.driverLabel(driver)}`,
          automatic: true,
          status: installation.code === 0 ? "completed" : "failed",
          detail: installation.code === 0 ? installation.stdout.trim() : installation.stderr.trim(),
        });
      }
    }
    let androidAvdAction: SetupAction | undefined;
    if (targets.includes("chrome-android") && options.androidAvdName) {
      androidAvdAction = await this.createAndroidAvd(options.androidAvdName, options.onOutput);
      results.push(androidAvdAction);
    }
    results.push(
      ...(await this.plan(targets)).filter((action) => {
        if (action.status !== "manual") return false;
        return !(androidAvdAction && action.label === TargetRegistry.definitions["chrome-android"].label);
      }),
    );
    return results;
  }

  static async appiumDriverStatus(targets: TargetName[]): Promise<AppiumDriverStatus[]> {
    const drivers = [
      ...(targets.includes("safari-ios") ? (["xcuitest"] as const) : []),
      ...(targets.includes("chrome-android") ? (["uiautomator2"] as const) : []),
    ];
    if (drivers.length === 0) return [];
    const listed = await CommandRunner.run(
      TestbenchPaths.localBinary("appium"),
      ["driver", "list", "--installed", "--json"],
      {
        env: { ...process.env, APPIUM_HOME: TestbenchPaths.cache("appium") },
        timeoutMs: 20_000,
      },
    );
    let installed: Record<string, { version?: string; installed?: boolean }> = {};
    if (listed.code === 0) {
      try {
        installed = JSON.parse(listed.stdout) as typeof installed;
      } catch {
        installed = {};
      }
    }
    return drivers.map((name) => ({
      name,
      installed: installed[name]?.installed === true,
      version: installed[name]?.version,
    }));
  }

  private static driverLabel(name: "xcuitest" | "uiautomator2"): string {
    return name === "xcuitest" ? "XCUITest" : "UiAutomator2";
  }

  private static async createAndroidAvd(name: string, onOutput?: (line: string) => void): Promise<SetupAction> {
    const sdkRoot = await DoctorService.androidSdkRoot();
    if (!sdkRoot)
      return {
        label: `Android-AVD ${name}`,
        automatic: false,
        status: "manual",
        detail: "Android SDK nicht gefunden.",
      };
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    const listed = await CommandRunner.run(emulator, ["-list-avds"], { timeoutMs: 8_000 });
    if (listed.stdout.split(/\r?\n/).includes(name))
      return {
        label: `Android-AVD ${name}`,
        automatic: true,
        status: "completed",
        detail: "Bereits vorhanden.",
      };

    const avdManager = await this.findSdkTool(sdkRoot, "avdmanager");
    if (!avdManager) {
      return {
        label: `Android-AVD ${name}`,
        automatic: false,
        status: "manual",
        detail: "Installiere die Android SDK Command-line Tools und starte die Einrichtung danach erneut.",
      };
    }
    const architecture = process.platform === "darwin" && process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    const image = `system-images;android-36;google_apis_playstore;${architecture}`;
    const imagePath = join(sdkRoot, "system-images", "android-36", "google_apis_playstore", architecture);
    if (!(await this.exists(imagePath))) {
      const sdkManager = await this.findSdkTool(sdkRoot, "sdkmanager");
      if (!sdkManager)
        return {
          label: `Android-AVD ${name}`,
          automatic: false,
          status: "manual",
          detail: `Installiere ${image} über den SDK Manager in Android Studio.`,
        };
      onOutput?.(`Android-Systemabbild ${image} wird installiert …`);
      const installed = await CommandRunner.run(sdkManager, [image], { timeoutMs: 1_800_000 });
      if (installed.code !== 0)
        return {
          label: `Android-AVD ${name}`,
          automatic: true,
          status: "failed",
          detail:
            `${installed.stderr.trim()}\nAkzeptiere die SDK-Lizenzen in Android Studio und versuche es erneut.`.trim(),
        };
    }
    onOutput?.(`Android-AVD ${name} wird angelegt …`);
    const created = await CommandRunner.run(
      avdManager,
      ["create", "avd", "--name", name, "--package", image, "--device", "pixel_6", "--force"],
      { input: "no\n", timeoutMs: 60_000 },
    );
    return {
      label: `Android-AVD ${name}`,
      automatic: true,
      status: created.code === 0 ? "completed" : "failed",
      detail:
        created.code === 0 ? `Mit dem Systemabbild ${image} angelegt.` : (created.stderr || created.stdout).trim(),
    };
  }

  private static async findSdkTool(sdkRoot: string, name: string): Promise<string | undefined> {
    const commandLineTools = join(sdkRoot, "cmdline-tools");
    try {
      const entries = await readdir(commandLineTools, { recursive: true });
      const executable = process.platform === "win32" ? `${name}.bat` : name;
      const relative = entries.find((entry) => basename(entry) === executable && entry.includes("bin"));
      return relative ? join(commandLineTools, relative) : undefined;
    } catch {
      return undefined;
    }
  }

  private static async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
