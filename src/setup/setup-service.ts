import { mkdir } from "node:fs/promises";
import type { DoctorCheck, TargetName } from "../config/types.js";
import type { TranslatableText } from "../i18n/translator.js";
import { TargetRegistry } from "../config/target-registry.js";
import { CommandRunner, type CommandResult } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { AndroidAvdService } from "./android-avd-service.js";
import { DoctorService } from "./doctor-service.js";
import type { SetupAction } from "./setup-types.js";
import { IosSigningService } from "./ios-signing-service.js";

const DRIVER_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DRIVER_STATUS_TIMEOUT_MS = 20_000;
export type { SetupAction } from "./setup-types.js";

export interface AppiumDriverStatus {
  name: "xcuitest" | "uiautomator2";
  installed: boolean;
  version?: string;
  problem?: TranslatableText;
}

export class SetupService {
  static async plan(targets: TargetName[], detectedChecks?: DoctorCheck[]): Promise<SetupAction[]> {
    targets = targets.filter((target) => TargetRegistry.isSupported(target));
    const actions: SetupAction[] = [];
    const mobileTargets = targets.filter((target) => target === "safari-ios" || target === "chrome-android");
    if (mobileTargets.length > 0 && DoctorService.isNodeSupported()) {
      const statuses = await this.appiumDriverStatus(mobileTargets);
      for (const driver of statuses) {
        actions.push(this.appiumPlanAction(driver, mobileTargets));
      }
    }
    const checks = detectedChecks ?? (await DoctorService.inspect(targets));
    if (targets.includes("chrome-android") && !this.hasDetectedPhysicalAndroidDevice(checks)) {
      const androidAction = await AndroidAvdService.plan();
      if (androidAction) actions.push({ ...androidAction, targets: ["chrome-android"] });
    }
    const physicalIosActions = checks
      .find((check) => check.id === "safari-ios")
      ?.devices?.filter((device) => device.deviceKind === "physical" && !device.compatible && device.detail)
      .map((device): SetupAction => {
        const action: SetupAction = {
          id: `ios-device-${device.id}`,
          label: { key: "environment.setupSafariOn", parameters: { deviceName: device.name } },
          automatic: false,
          status: "manual",
          detail: device.detail,
          targets: ["safari-ios"],
        };
        if (device.setupChecks?.some((check) => check.id === "signing" && !check.ready)) {
          action.command = IosSigningService.openWdaCommand();
        }
        return action;
      });
    actions.push(...(physicalIosActions ?? []));
    for (const check of checks.filter((entry) => entry.status === "blocked" || entry.status === "action")) {
      if (check.id === "safari-ios" && physicalIosActions?.length) continue;
      const actionId = `check-${check.id}`;
      if (check.action && !actions.some((action) => action.id === actionId)) {
        actions.push({
          id: actionId,
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
          id: "node-runtime",
          label: "Node.js",
          automatic: false,
          status: "failed",
          detail: { key: "environment.setupNodeRequired" },
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
        const driver = this.targetDriver(target);
        const existing = existingDrivers.get(driver);
        if (existing?.installed) {
          results.push({
            id: `appium-${driver}`,
            label: `Appium ${this.driverLabel(driver)}`,
            automatic: true,
            status: "completed",
            detail: {
              key: "environment.setupDriverAlreadyInstalled",
              parameters: { version: existing.version ?? "unknown" },
            },
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
        results.push(this.appiumInstallResult(driver, installation));
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
        return !(androidAvdAction && action.id === "check-chrome-android");
      }),
    );
    return results;
  }

  static async appiumDriverStatus(targets: TargetName[]): Promise<AppiumDriverStatus[]> {
    const drivers: AppiumDriverStatus["name"][] = [];
    if (targets.includes("safari-ios")) drivers.push("xcuitest");
    if (targets.includes("chrome-android")) drivers.push("uiautomator2");
    if (drivers.length === 0) return [];
    const listed = await CommandRunner.run(
      process.execPath,
      [TestbenchPaths.packageBinary("appium"), "driver", "list", "--installed", "--json"],
      {
        env: { ...process.env, APPIUM_HOME: TestbenchPaths.data("appium") },
        timeoutMs: DRIVER_STATUS_TIMEOUT_MS,
      },
    );
    if (listed.code !== 0) {
      const diagnostic = this.commandDiagnostic(listed);
      const problem: TranslatableText = diagnostic
        ? { key: "environment.setupDriverStatusFailed", parameters: { reason: diagnostic } }
        : { key: "environment.setupDriverStatusExited", parameters: { code: listed.code } };
      return drivers.map((name) => ({ name, installed: false, problem }));
    }
    let installed: Record<string, { version?: string; installed?: boolean }> = {};
    try {
      installed = JSON.parse(listed.stdout) as typeof installed;
    } catch {
      const output = this.commandDiagnostic(listed);
      const problem: TranslatableText = output
        ? { key: "environment.setupDriverStatusInvalid", parameters: { output } }
        : { key: "environment.setupDriverStatusEmpty" };
      return drivers.map((name) => ({ name, installed: false, problem }));
    }
    return drivers.map((name) => ({
      name,
      installed: installed[name]?.installed === true,
      version: installed[name]?.version,
    }));
  }

  private static driverLabel(name: "xcuitest" | "uiautomator2"): string {
    const labels = { xcuitest: "XCUITest", uiautomator2: "UiAutomator2" } as const;
    return labels[name];
  }

  private static appiumPlanAction(driver: AppiumDriverStatus, mobileTargets: TargetName[]): SetupAction {
    const action: SetupAction = {
      id: `appium-${driver.name}`,
      label: `Appium ${this.driverLabel(driver.name)}`,
      automatic: true,
      status: "planned",
      targets: [this.driverTarget(driver.name)],
      detail: { key: "environment.setupDriverMissing" },
    };
    if (driver.problem) {
      action.automatic = false;
      action.status = "failed";
      action.detail = driver.problem;
      return action;
    }
    if (driver.installed) {
      action.status = "completed";
      action.detail = {
        key: "environment.setupDriverInstalled",
        parameters: { version: driver.version ?? "unknown" },
      };
      return action;
    }
    action.command = TestbenchPaths.cliCommand("setup", "--yes", "--targets", mobileTargets.join(","));
    return action;
  }

  private static appiumInstallResult(driver: AppiumDriverStatus["name"], installation: CommandResult): SetupAction {
    const action: SetupAction = {
      id: `appium-${driver}`,
      label: `Appium ${this.driverLabel(driver)}`,
      automatic: true,
      status: "completed",
      detail: installation.stdout.trim() || { key: "environment.setupDriverInstallCompleted" },
    };
    if (installation.code === 0) return action;
    action.status = "failed";
    const diagnostic = this.commandDiagnostic(installation);
    action.detail = diagnostic ?? {
      key: "environment.setupDriverInstallExited",
      parameters: { code: installation.code },
    };
    return action;
  }

  private static driverTarget(name: AppiumDriverStatus["name"]): TargetName {
    if (name === "xcuitest") return "safari-ios";
    return "chrome-android";
  }

  private static targetDriver(target: TargetName): AppiumDriverStatus["name"] {
    if (target === "safari-ios") return "xcuitest";
    return "uiautomator2";
  }

  private static commandDiagnostic(result: CommandResult): string | undefined {
    return result.stderr.trim() || result.stdout.trim() || undefined;
  }

  private static hasDetectedPhysicalAndroidDevice(checks: DoctorCheck[]): boolean {
    return Boolean(
      checks
        .find((check) => check.id === "chrome-android")
        ?.devices?.some((device) => device.deviceKind === "physical"),
    );
  }
}
