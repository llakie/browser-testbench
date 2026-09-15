import { access, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TargetName } from "../config/types.js";
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

export class SetupService {
  static async plan(targets: TargetName[]): Promise<SetupAction[]> {
    const actions: SetupAction[] = [];
    if (targets.some((target) => target === "safari-ios" || target === "chrome-android")) {
      actions.push({
        label: "Install local Appium extensions",
        command: "btb setup --yes",
        automatic: true,
        status: "planned",
      });
    }
    if (targets.includes("safari")) {
      actions.push({
        label: "Enable Safari WebDriver",
        command: "sudo safaridriver --enable",
        automatic: false,
        status: "manual",
        detail: "Requires your macOS password and can show a system dialog.",
      });
    }
    const checks = await DoctorService.inspect(targets);
    for (const check of checks.filter((entry) => entry.status === "blocked" || entry.status === "action")) {
      if (check.action && !actions.some((action) => action.label === check.label)) {
        actions.push({ label: check.label, automatic: false, status: "manual", detail: check.action });
      }
    }
    return actions;
  }

  static async install(
    targets: TargetName[],
    options: { androidAvdName?: string; onOutput?: (line: string) => void } = {},
  ): Promise<SetupAction[]> {
    const results: SetupAction[] = [];
    const mobileTargets = targets.filter((target) => target === "safari-ios" || target === "chrome-android");
    if (mobileTargets.length > 0) {
      const appiumHome = TestbenchPaths.cache("appium");
      await mkdir(appiumHome, { recursive: true });
      for (const target of mobileTargets) {
        const driver = target === "safari-ios" ? "xcuitest" : "uiautomator2";
        const existing = await CommandRunner.run(
          TestbenchPaths.localBinary("appium"),
          ["driver", "list", "--installed", "--json"],
          {
            env: { ...process.env, APPIUM_HOME: appiumHome },
            timeoutMs: 20_000,
          },
        );
        if (existing.code === 0 && existing.stdout.includes(`\"${driver}\"`)) {
          results.push({
            label: `Appium ${driver} driver`,
            automatic: true,
            status: "completed",
            detail: "Already installed.",
          });
          continue;
        }
        options.onOutput?.(`Installing Appium driver ${driver}...`);
        const installation = await CommandRunner.run(
          TestbenchPaths.localBinary("appium"),
          ["driver", "install", driver],
          {
            env: { ...process.env, APPIUM_HOME: appiumHome },
            timeoutMs: 600_000,
          },
        );
        results.push({
          label: `Appium ${driver} driver`,
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
        return !(androidAvdAction && action.label === "Chrome on Android Emulator");
      }),
    );
    return results;
  }

  private static async createAndroidAvd(name: string, onOutput?: (line: string) => void): Promise<SetupAction> {
    const sdkRoot = await DoctorService.androidSdkRoot();
    if (!sdkRoot)
      return { label: `Android AVD ${name}`, automatic: false, status: "manual", detail: "Android SDK not found." };
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    const listed = await CommandRunner.run(emulator, ["-list-avds"], { timeoutMs: 8_000 });
    if (listed.stdout.split(/\r?\n/).includes(name))
      return { label: `Android AVD ${name}`, automatic: true, status: "completed", detail: "Already exists." };

    const avdManager = await this.findSdkTool(sdkRoot, "avdmanager");
    if (!avdManager) {
      return {
        label: `Android AVD ${name}`,
        automatic: false,
        status: "manual",
        detail: "Install Android SDK Command-line Tools, then rerun setup with --android-avd.",
      };
    }
    const architecture = process.platform === "darwin" && process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    const image = `system-images;android-36;google_apis_playstore;${architecture}`;
    const imagePath = join(sdkRoot, "system-images", "android-36", "google_apis_playstore", architecture);
    if (!(await this.exists(imagePath))) {
      const sdkManager = await this.findSdkTool(sdkRoot, "sdkmanager");
      if (!sdkManager)
        return {
          label: `Android AVD ${name}`,
          automatic: false,
          status: "manual",
          detail: `Install ${image} from Android Studio's SDK Manager.`,
        };
      onOutput?.(`Installing Android system image ${image}...`);
      const installed = await CommandRunner.run(sdkManager, [image], { timeoutMs: 1_800_000 });
      if (installed.code !== 0)
        return {
          label: `Android AVD ${name}`,
          automatic: true,
          status: "failed",
          detail: `${installed.stderr.trim()}\nAccept SDK licenses in Android Studio, then retry.`.trim(),
        };
    }
    onOutput?.(`Creating Android AVD ${name}...`);
    const created = await CommandRunner.run(
      avdManager,
      ["create", "avd", "--name", name, "--package", image, "--device", "pixel_6", "--force"],
      { input: "no\n", timeoutMs: 60_000 },
    );
    return {
      label: `Android AVD ${name}`,
      automatic: true,
      status: created.code === 0 ? "completed" : "failed",
      detail: created.code === 0 ? `Created from ${image}.` : (created.stderr || created.stdout).trim(),
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
