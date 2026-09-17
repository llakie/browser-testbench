import { mkdir } from "node:fs/promises";
import type { DoctorCheck, TargetName } from "../config/types.js";
import { TargetRegistry } from "../config/target-registry.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { AndroidAvdService } from "./android-avd-service.js";
import { DoctorService } from "./doctor-service.js";
import type { SetupAction } from "./setup-types.js";

const DRIVER_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DRIVER_STATUS_TIMEOUT_MS = 20_000;
export type { SetupAction } from "./setup-types.js";

export interface AppiumDriverStatus {
  name: "xcuitest" | "uiautomator2";
  installed: boolean;
  version?: string;
}

export class SetupService {
  static async plan(targets: TargetName[], detectedChecks?: DoctorCheck[]): Promise<SetupAction[]> {
    targets = targets.filter((target) => TargetRegistry.isSupported(target));
    const actions: SetupAction[] = [];
    const mobileTargets = targets.filter((target) => target === "safari-ios" || target === "chrome-android");
    if (mobileTargets.length > 0 && DoctorService.isNodeSupported()) {
      const statuses = await this.appiumDriverStatus(mobileTargets);
      for (const driver of statuses) {
        const target = driver.name === "xcuitest" ? "safari-ios" : "chrome-android";
        actions.push({
          label: `Appium ${this.driverLabel(driver.name)}`,
          command: driver.installed
            ? undefined
            : TestbenchPaths.cliCommand("setup", "--yes", "--targets", mobileTargets.join(",")),
          automatic: true,
          status: driver.installed ? "completed" : "planned",
          targets: [target],
          detail: driver.installed
            ? `Version ${driver.version ?? "unknown"} is installed locally.`
            : "The driver is not installed yet.",
        });
      }
    }
    const checks = detectedChecks ?? (await DoctorService.inspect(targets));
    const androidAction =
      targets.includes("chrome-android") && !this.hasDetectedPhysicalAndroidDevice(checks)
        ? await AndroidAvdService.plan()
        : undefined;
    if (androidAction) actions.push({ ...androidAction, targets: ["chrome-android"] });
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
    options: { onOutput?: (line: string) => void } = {},
  ): Promise<SetupAction[]> {
    targets = targets.filter((target) => TargetRegistry.isSupported(target));
    const results: SetupAction[] = [];
    const mobileTargets = targets.filter((target) => target === "safari-ios" || target === "chrome-android");
    if (mobileTargets.length > 0 && !DoctorService.isNodeSupported()) {
      return [
        {
          label: "Node.js",
          automatic: false,
          status: "failed",
          detail: "Appium setup requires Node.js 22.12 LTS or Node.js 24 or newer.",
        },
      ];
    }
    if (mobileTargets.length > 0) {
      const appiumHome = TestbenchPaths.data("appium");
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
            detail: `Version ${existing.version ?? "unknown"} is already installed locally.`,
          });
          continue;
        }
        options.onOutput?.(`Installing Appium driver ${driver} …`);
        const installation = await CommandRunner.run(
          process.execPath,
          [TestbenchPaths.packageBinary("appium"), "driver", "install", driver],
          {
            env: { ...process.env, APPIUM_HOME: appiumHome },
            timeoutMs: DRIVER_INSTALL_TIMEOUT_MS,
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
    if (targets.includes("chrome-android")) {
      const checks = await DoctorService.inspect(["chrome-android"]);
      if (!this.hasDetectedPhysicalAndroidDevice(checks)) {
        androidAvdAction = await AndroidAvdService.ensure(options.onOutput);
        results.push(androidAvdAction);
      }
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
      process.execPath,
      [TestbenchPaths.packageBinary("appium"), "driver", "list", "--installed", "--json"],
      {
        env: { ...process.env, APPIUM_HOME: TestbenchPaths.data("appium") },
        timeoutMs: DRIVER_STATUS_TIMEOUT_MS,
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

  private static hasDetectedPhysicalAndroidDevice(checks: DoctorCheck[]): boolean {
    return Boolean(
      checks
        .find((check) => check.id === "chrome-android")
        ?.devices?.some((device) => device.deviceKind === "physical"),
    );
  }
}
