import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetDeviceOption } from "../config/types.js";
import { CommandRunner } from "../infrastructure/command-runner.js";

const COMMAND_TIMEOUT_MS = 8_000;
const LEGACY_DEVICE_TIMEOUT_SECONDS = "1";

export interface CoreDevice {
  identifier?: string;
  connectionProperties?: {
    lastConnectionDate?: string;
    pairingState?: string;
    transportType?: string;
  };
  deviceProperties?: {
    developerModeStatus?: string;
    name?: string;
    osVersionNumber?: string;
  };
  hardwareProperties?: {
    deviceType?: string;
    marketingName?: string;
    platform?: string;
    reality?: string;
    udid?: string;
  };
}

export interface SimulatorRuntime {
  isAvailable?: boolean;
  name?: string;
  version?: string;
  identifier?: string;
}

export interface SimulatorDevice {
  name?: string;
  udid?: string;
  isAvailable?: boolean;
  state?: string;
}

export interface XcodeDevice {
  identifier?: string;
  name?: string;
  available?: boolean;
  simulator?: boolean;
  platform?: string;
  interface?: string;
  operatingSystemVersion?: string;
  modelName?: string;
}

export interface IosDeviceInventory {
  simulators: TargetDeviceOption[];
  knownPhysicalDevices: CoreDevice[];
  availablePhysicalIdentifiers: Set<string>;
}

export class IosDeviceDiscovery {
  static async inventory(): Promise<IosDeviceInventory> {
    const [simulators, physical] = await Promise.all([this.simulatorDevices(), this.coreDevices()]);
    return {
      simulators,
      knownPhysicalDevices: physical.known,
      availablePhysicalIdentifiers: physical.available,
    };
  }

  static async fingerprint(): Promise<string> {
    const devices = await this.xcodeDevices();
    return JSON.stringify(
      devices
        .filter((device) => device.platform === "com.apple.platform.iphoneos" && device.simulator === false)
        .map((device) => ({
          id: device.identifier,
          available: device.available === true,
          connection: device.interface,
          version: device.operatingSystemVersion,
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    );
  }

  static simulatorDeviceOptions(
    runtimes: SimulatorRuntime[],
    devices: Record<string, SimulatorDevice[]>,
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

  static legacyDeviceData(devices: XcodeDevice[], now = Date.now()): { known: CoreDevice[]; available: Set<string> } {
    const known = devices.flatMap((device) => {
      if (
        device.platform !== "com.apple.platform.iphoneos" ||
        device.simulator !== false ||
        !device.available ||
        !device.identifier
      )
        return [];
      const name = device.modelName ?? device.name ?? "Apple device";
      return [
        {
          identifier: device.identifier,
          connectionProperties: {
            lastConnectionDate: new Date(now).toISOString(),
            pairingState: "paired",
            transportType: device.interface === "usb" ? "wired" : device.interface,
          },
          deviceProperties: {
            developerModeStatus: "enabled",
            name: device.name,
            osVersionNumber: device.operatingSystemVersion?.split(" ")[0],
          },
          hardwareProperties: {
            deviceType: name.startsWith("iPad") ? "iPad" : "iPhone",
            marketingName: name,
            platform: "iOS",
            reality: "physical",
            udid: device.identifier,
          },
        },
      ];
    });
    return { known, available: new Set(known.map((device) => device.identifier!)) };
  }

  private static async simulatorDevices(): Promise<TargetDeviceOption[]> {
    const [runtimes, devices] = await Promise.all([
      CommandRunner.run("xcrun", ["simctl", "list", "runtimes", "--json"], { timeoutMs: COMMAND_TIMEOUT_MS }),
      CommandRunner.run("xcrun", ["simctl", "list", "devices", "available", "--json"], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    ]);
    if (runtimes.code !== 0 || devices.code !== 0) return [];
    try {
      const runtimeData = JSON.parse(runtimes.stdout) as { runtimes?: SimulatorRuntime[] };
      const deviceData = JSON.parse(devices.stdout) as { devices?: Record<string, SimulatorDevice[]> };
      return this.simulatorDeviceOptions(
        runtimeData.runtimes?.filter((runtime) => runtime.isAvailable && runtime.name?.includes("iOS")) ?? [],
        deviceData.devices ?? {},
      );
    } catch {
      return [];
    }
  }

  private static async coreDevices(): Promise<{ known: CoreDevice[]; available: Set<string> }> {
    const [known, available] = await Promise.all([this.runDeviceCtl(), this.runDeviceCtl("State == 'available'")]);
    const legacy = known.some((device) => device.connectionProperties?.pairingState === "unsupported")
      ? await this.legacyDevices()
      : { known: [], available: new Set<string>() };
    return {
      known: [...known, ...legacy.known],
      available: new Set([
        ...available.flatMap((device) =>
          device.hardwareProperties?.udid
            ? [device.hardwareProperties.udid]
            : device.identifier
              ? [device.identifier]
              : [],
        ),
        ...legacy.available,
      ]),
    };
  }

  private static async legacyDevices(): Promise<{ known: CoreDevice[]; available: Set<string> }> {
    return this.legacyDeviceData(await this.xcodeDevices());
  }

  private static async xcodeDevices(): Promise<XcodeDevice[]> {
    const result = await CommandRunner.run("xcrun", ["xcdevice", "list", "--timeout", LEGACY_DEVICE_TIMEOUT_SECONDS], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) return [];
    try {
      return JSON.parse(result.stdout) as XcodeDevice[];
    } catch {
      return [];
    }
  }

  private static async runDeviceCtl(filter?: string): Promise<CoreDevice[]> {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-ios-"));
    const output = join(directory, "devices.json");
    try {
      const args = ["devicectl", "list", "devices", "--timeout", "5", "--json-output", output, "--quiet"];
      if (filter) args.splice(3, 0, "--filter", filter);
      const result = await CommandRunner.run("xcrun", args, { timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.code !== 0) return [];
      const payload = JSON.parse(await readFile(output, "utf8")) as { result?: { devices?: CoreDevice[] } };
      return payload.result?.devices ?? [];
    } catch {
      return [];
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
