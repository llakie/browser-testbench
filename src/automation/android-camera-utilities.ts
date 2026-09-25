import type { TargetConfig } from "../config/types.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { CommandRunner } from "../infrastructure/command-runner.js";

type NativePermissionName = "camera" | "microphone";

const ANDROID_PERMISSIONS: Record<NativePermissionName, string> = {
  camera: "android.permission.CAMERA",
  microphone: "android.permission.RECORD_AUDIO",
};

export class AndroidCameraUtilities {
  private readonly previous = new Map<string, boolean>();
  private packageName?: string;
  private adbPath?: string;

  constructor(
    private readonly target: TargetConfig,
    private readonly capabilities: Record<string, unknown>,
  ) {}

  async grant(names: NativePermissionName[]): Promise<{ packageName: string; permissions: NativePermissionName[] }> {
    if (!this.target.udid) throw this.error("PERMISSION_UNSUPPORTED", "Android target has no ADB serial.");
    const root = await AndroidSdk.root();
    if (!root) throw this.error("PERMISSION_UNSUPPORTED", "Android SDK was not found.");
    this.adbPath = AndroidSdk.adb(root);
    this.packageName = await this.browserPackage();
    for (const name of [...new Set(names)]) {
      const permission = ANDROID_PERMISSIONS[name];
      const granted = await this.isGranted(this.packageName, permission);
      this.previous.set(permission, granted);
      if (!granted) {
        await this.command(["shell", "pm", "grant", this.packageName, permission], name);
        if (!(await this.isGranted(this.packageName, permission)))
          throw this.error("PERMISSION_DENIED", `Android did not grant ${permission}.`, name);
      }
    }
    return { packageName: this.packageName, permissions: [...new Set(names)] };
  }

  async restore(): Promise<void> {
    if (!this.packageName || !this.adbPath || !this.target.udid) return;
    const failures: Error[] = [];
    for (const [permission, wasGranted] of this.previous) {
      if (wasGranted) continue;
      const result = await CommandRunner.run(
        this.adbPath,
        ["-s", this.target.udid, "shell", "pm", "revoke", this.packageName, permission],
        { timeoutMs: TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS },
      );
      if (result.code !== 0) failures.push(new Error((result.stderr || result.stdout).trim()));
    }
    this.previous.clear();
    if (failures.length) throw new AggregateError(failures, "Could not restore Android browser permissions.");
  }

  private async browserPackage(): Promise<string> {
    const options = [this.capabilities["appium:chromeOptions"], this.capabilities["goog:chromeOptions"]].find(
      (value): value is Record<string, unknown> => Boolean(value && typeof value === "object"),
    );
    if (typeof options?.androidPackage === "string" && options.androidPackage) return options.androidPackage;
    const result = await this.command([
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      "https://example.com",
    ]);
    const component = result.stdout
      .trim()
      .split(/\s+/u)
      .findLast((value) => value.includes("/"));
    const packageName = component?.split("/")[0];
    if (!packageName) throw this.error("PERMISSION_UNSUPPORTED", "Android browser package could not be determined.");
    return packageName;
  }

  private async isGranted(packageName: string, permission: string): Promise<boolean> {
    const result = await this.command(["shell", "dumpsys", "package", packageName]);
    const escaped = permission.replaceAll(".", "\\.");
    return new RegExp(`${escaped}: granted=true`, "u").test(result.stdout);
  }

  private async command(
    arguments_: string[],
    permission?: string,
  ): Promise<Awaited<ReturnType<typeof CommandRunner.run>>> {
    const result = await CommandRunner.run(this.adbPath!, ["-s", this.target.udid!, ...arguments_], {
      timeoutMs: TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0)
      throw this.error(
        "PERMISSION_DENIED",
        (result.stderr || result.stdout).trim() || "ADB command failed.",
        permission,
      );
    return result;
  }

  private error(
    code: "PERMISSION_UNSUPPORTED" | "PERMISSION_DENIED",
    message: string,
    permission?: string,
  ): TestbenchError {
    return new TestbenchError(code, message, {
      operation: "permission.android",
      status: code === "PERMISSION_UNSUPPORTED" ? 409 : 403,
      details: {
        platform: "android",
        serial: this.target.udid,
        packageName: this.packageName,
        permission,
      },
    });
  }
}
