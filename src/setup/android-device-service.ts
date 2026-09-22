import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorCheck, TargetDeviceOption } from "../config/types.js";
import { TargetRegistry } from "../config/target-registry.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { IniParser } from "../infrastructure/ini-parser.js";

const DEVICE_LIST_TIMEOUT_MS = 8_000;
const DEVICE_QUERY_TIMEOUT_MS = 5_000;

interface AdbDevice {
  serial: string;
  state: string;
  attributes: Record<string, string>;
}

export class AndroidDeviceService {
  static async inspect(): Promise<DoctorCheck> {
    const label = TargetRegistry.definitions["chrome-android"].label;
    const sdkRoot = await AndroidSdk.root();
    if (!sdkRoot) {
      return {
        id: "chrome-android",
        label,
        status: "blocked",
        detail: "Android SDK not found.",
        action: "Install Android Studio or set the ANDROID_HOME environment variable.",
        messages: {
          detail: { key: "environment.androidSdkMissing" },
          action: { key: "environment.androidSdkAction" },
        },
      };
    }

    const [physical, virtual] = await Promise.all([this.physicalDevices(sdkRoot), this.virtualDevices(sdkRoot)]);
    const devices = [...physical, ...virtual];
    const compatible = devices.filter((device) => device.compatible);
    if (compatible.length > 0) {
      return {
        id: "chrome-android",
        label,
        status: "ready",
        detail: this.readyDetail(devices),
        devices,
        messages: { detail: this.readyMessage(devices) },
      };
    }

    const unavailablePhysical = physical.find((device) => !device.compatible);
    if (unavailablePhysical) {
      return {
        id: "chrome-android",
        label,
        status: "action",
        detail: unavailablePhysical.detail ?? "A connected Android device is not ready.",
        action: this.physicalDeviceAction(unavailablePhysical.state),
        devices,
        messages: {
          detail: unavailablePhysical.messages?.detail ?? { key: "environment.androidPhysicalAttention" },
          action: { key: this.physicalDeviceActionKey(unavailablePhysical.state) },
        },
      };
    }
    if (virtual.length > 0) {
      return {
        id: "chrome-android",
        label,
        status: "action",
        detail: "Android emulators were found, but none has a Chrome-compatible Google Play system image.",
        action: "Create an AVD with a Google Play system image.",
        devices,
        messages: {
          detail: { key: "environment.androidEmulatorIncompatible" },
          action: { key: "environment.androidCreateAvd" },
        },
      };
    }
    return {
      id: "chrome-android",
      label,
      status: "action",
      detail: "No Android device or compatible emulator was found.",
      action: "Connect a USB-debug-enabled Android device or create a Google Play AVD in Android Studio.",
      messages: {
        detail: { key: "environment.androidNone" },
        action: { key: "environment.androidConnect" },
      },
    };
  }

  static readyDetail(devices: TargetDeviceOption[]): string {
    const ready = devices.filter((device) => device.compatible);
    const physicalReady = ready.filter((device) => device.deviceKind === "physical").length;
    const emulatorReady = ready.length - physicalReady;
    const physicalAttention = devices.filter((device) => device.deviceKind === "physical" && !device.compatible).length;
    const parts = [
      physicalReady ? `${physicalReady} connected ${physicalReady === 1 ? "device" : "devices"}` : "",
      emulatorReady ? `${emulatorReady} ${emulatorReady === 1 ? "emulator" : "emulators"}` : "",
    ].filter(Boolean);
    const attention = physicalAttention
      ? ` ${physicalAttention} physical ${physicalAttention === 1 ? "device needs" : "devices need"} attention.`
      : "";
    return `${parts.join(" and ")} ready for Chrome testing.${attention}`;
  }

  static parseAdbDevices(output: string): AdbDevice[] {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("List of devices") && !line.startsWith("* daemon"))
      .flatMap((line) => {
        const match = line.match(/^(\S+)\s+(device|unauthorized|offline|no permissions)(?:\s+(.*))?$/);
        if (!match) return [];
        const attributes = Object.fromEntries(
          (match[3] ?? "")
            .split(/\s+/)
            .map((part) => part.match(/^([^:]+):(.+)$/))
            .filter((entry): entry is RegExpMatchArray => Boolean(entry))
            .map((entry) => [entry[1], entry[2]]),
        );
        return [{ serial: match[1]!, state: match[2]!, attributes }];
      });
  }

  static async physicalDevices(sdkRoot: string): Promise<TargetDeviceOption[]> {
    const adb = AndroidSdk.adb(sdkRoot);
    if (!(await this.exists(adb))) return [];
    const listed = await CommandRunner.run(adb, ["devices", "-l"], { timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    if (listed.code !== 0) return [];
    const devices = this.parseAdbDevices(listed.stdout).filter((device) => !device.serial.startsWith("emulator-"));
    return Promise.all(devices.map((device) => this.physicalDeviceOption(adb, device)));
  }

  static async avdOptions(names: string[]): Promise<TargetDeviceOption[]> {
    const avdHome =
      process.env.ANDROID_AVD_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".android", "avd");
    const options: TargetDeviceOption[] = [];
    for (const name of names) {
      try {
        const pointer = IniParser.parse(await readFile(join(avdHome, `${name}.ini`), "utf8"));
        const path = pointer.get("path");
        if (!path) continue;
        const config = IniParser.parse(await readFile(join(path, "config.ini"), "utf8"));
        const image = config.get("image.sysdir.1");
        const platformVersion = image?.match(/android-([^\\/]+)/)?.[1];
        options.push({
          id: name,
          name,
          platformVersion,
          state: "Available",
          deviceKind: "emulator",
          compatible: this.hasGooglePlayTag(config),
          config: {
            name: "chrome-android",
            deviceKind: "emulator",
            avd: name,
            ...(platformVersion ? { platformVersion } : {}),
          },
        });
      } catch {
        // Ignore malformed or externally managed AVD entries.
      }
    }
    return options;
  }

  private static async virtualDevices(sdkRoot: string): Promise<TargetDeviceOption[]> {
    const emulator = join(sdkRoot, "emulator", AndroidSdk.executableName("emulator"));
    if (!(await this.exists(emulator))) return [];
    const listed = await CommandRunner.run(emulator, ["-list-avds"], { timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    if (listed.code !== 0) return [];
    return this.avdOptions(
      listed.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }

  private static async physicalDeviceOption(adb: string, device: AdbDevice): Promise<TargetDeviceOption> {
    const fallbackName = this.displayValue(device.attributes.model) ?? device.serial;
    if (device.state !== "device") {
      return {
        id: device.serial,
        name: fallbackName,
        state: device.state,
        deviceKind: "physical",
        compatible: false,
        detail: `Android device ${fallbackName} is ${device.state}.`,
        messages: {
          detail: {
            key: "environment.androidDeviceState",
            parameters: { deviceName: fallbackName, state: device.state },
          },
        },
        config: { name: "chrome-android", deviceKind: "physical", deviceName: fallbackName, udid: device.serial },
      };
    }
    const [model, version, chrome] = await Promise.all([
      this.query(adb, device.serial, ["shell", "getprop", "ro.product.model"]),
      this.query(adb, device.serial, ["shell", "getprop", "ro.build.version.release"]),
      this.query(adb, device.serial, ["shell", "pm", "path", "com.android.chrome"]),
    ]);
    const name = model || fallbackName;
    const compatible = chrome.startsWith("package:");
    return {
      id: device.serial,
      name,
      platformVersion: version || undefined,
      state: "Connected",
      deviceKind: "physical",
      compatible,
      ...(!compatible
        ? {
            detail: `Chrome is not installed on ${name}.`,
            messages: { detail: { key: "environment.chromeMissing" as const, parameters: { deviceName: name } } },
          }
        : {}),
      config: {
        name: "chrome-android",
        deviceKind: "physical",
        deviceName: name,
        ...(version ? { platformVersion: version } : {}),
        udid: device.serial,
      },
    };
  }

  private static async query(adb: string, serial: string, args: string[]): Promise<string> {
    const result = await CommandRunner.run(adb, ["-s", serial, ...args], { timeoutMs: DEVICE_QUERY_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private static displayValue(value?: string): string | undefined {
    return value?.replaceAll("_", " ");
  }

  private static hasGooglePlayTag(config: ReadonlyMap<string, string>): boolean {
    const tags = [config.get("tag.id"), config.get("tag.ids")].flatMap((value) => value?.split(",") ?? []);
    return tags.some((tag) => /^google_apis_playstore(?:_|$)/.test(tag.trim()));
  }

  private static physicalDeviceAction(state?: string): string {
    if (state === "unauthorized") return "Unlock the device and accept the USB debugging authorization prompt.";
    if (state === "offline") return "Reconnect the USB cable and restart USB debugging on the device.";
    if (state === "no permissions") return "Grant this user access to the Android USB device, then reconnect it.";
    return "Install or enable Chrome on the connected Android device.";
  }

  private static physicalDeviceActionKey(state?: string) {
    if (state === "unauthorized") return "environment.androidUnauthorized" as const;
    if (state === "offline") return "environment.androidOffline" as const;
    if (state === "no permissions") return "environment.androidPermissions" as const;
    return "environment.androidChromeAction" as const;
  }

  private static readyMessage(devices: TargetDeviceOption[]) {
    const count = devices.filter((device) => device.compatible).length;
    const attention = devices.filter((device) => device.deviceKind === "physical" && !device.compatible).length;
    return {
      key: attention ? ("environment.androidReadyAttention" as const) : ("environment.androidReady" as const),
      parameters: { count, attention },
      count,
    };
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
