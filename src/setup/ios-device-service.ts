import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck, TargetDeviceOption } from "../config/types.js";
import { TargetRegistry } from "../config/target-registry.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { IosSigningService, type IosSigningConfiguration } from "./ios-signing-service.js";

const COMMAND_TIMEOUT_MS = 8_000;
const LEGACY_DEVICE_TIMEOUT_SECONDS = "1";
const RECENT_DEVICE_WINDOW_MS = 2 * 60_000;

interface CoreDevice {
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

interface SimulatorRuntime {
  isAvailable?: boolean;
  name?: string;
  version?: string;
  identifier?: string;
}

interface SimulatorDevice {
  name?: string;
  udid?: string;
  isAvailable?: boolean;
  state?: string;
}

interface XcodeDevice {
  identifier?: string;
  name?: string;
  available?: boolean;
  simulator?: boolean;
  platform?: string;
  interface?: string;
  operatingSystemVersion?: string;
  modelName?: string;
}

export class IosDeviceService {
  static async inspect(): Promise<DoctorCheck> {
    const label = TargetRegistry.definitions["safari-ios"].label;
    const xcode = await CommandRunner.run("xcodebuild", ["-version"], { timeoutMs: COMMAND_TIMEOUT_MS });
    if (xcode.code !== 0) {
      return {
        id: "safari-ios",
        label,
        status: "blocked",
        detail: "Xcode is not available.",
        action: "Install Xcode and select the installation with xcode-select.",
      };
    }

    const [simulators, physical, signing] = await Promise.all([
      this.simulatorDevices(),
      this.coreDevices(),
      IosSigningService.configuration(),
    ]);
    const physicalOptions = this.physicalDeviceOptions(
      physical.known,
      physical.available,
      signing.selected,
      Date.now(),
      signing.problem,
    );
    const devices = [...simulators, ...physicalOptions];
    const ready = devices.filter((device) => device.compatible);

    if (ready.length > 0) {
      return {
        id: "safari-ios",
        label,
        status: "ready",
        detail: this.readyDetail(devices),
        devices,
      };
    }

    const physicalDevice = physicalOptions[0];
    if (physicalDevice) {
      return {
        id: "safari-ios",
        label,
        status: "action",
        detail: physicalDevice.detail ?? "A physical Apple device needs attention.",
        action: this.physicalDeviceAction(physicalDevice, signing.problem),
        devices,
      };
    }
    return {
      id: "safari-ios",
      label,
      status: "action",
      detail: "No iOS Simulator or recently connected physical iPhone or iPad was found.",
      action: "Connect an unlocked iPhone or iPad by USB and trust this Mac, or create an iOS Simulator in Xcode.",
    };
  }

  static readyDetail(devices: TargetDeviceOption[]): string {
    const ready = devices.filter((device) => device.compatible);
    const physicalReady = ready.filter((device) => device.deviceKind === "physical").length;
    const simulatorReady = ready.length - physicalReady;
    const physicalAttention = devices.filter((device) => device.deviceKind === "physical" && !device.compatible).length;
    const parts = [
      simulatorReady ? `${simulatorReady} ${simulatorReady === 1 ? "simulator" : "simulators"}` : "",
      physicalReady ? `${physicalReady} physical ${physicalReady === 1 ? "device" : "devices"}` : "",
    ].filter(Boolean);
    const attention = physicalAttention
      ? ` ${physicalAttention} physical ${physicalAttention === 1 ? "device needs" : "devices need"} attention.`
      : "";
    return `${parts.join(" and ")} ready for Safari testing.${attention}`;
  }

  static physicalDeviceOptions(
    known: CoreDevice[],
    availableIdentifiers: Set<string>,
    signing?: IosSigningConfiguration,
    now = Date.now(),
    signingProblem?: string,
  ): TargetDeviceOption[] {
    return known.flatMap((device) => {
      const hardware = device.hardwareProperties;
      if (hardware?.platform !== "iOS" || hardware.reality !== "physical" || !hardware.udid) return [];
      const recentlyConnected =
        device.connectionProperties?.lastConnectionDate !== undefined &&
        now - Date.parse(device.connectionProperties.lastConnectionDate) <= RECENT_DEVICE_WINDOW_MS;
      const connected = Boolean(device.identifier && availableIdentifiers.has(device.identifier));
      if (!connected && !recentlyConnected) return [];

      const name = hardware.marketingName ?? device.deviceProperties?.name ?? hardware.deviceType ?? "Apple device";
      const version = device.deviceProperties?.osVersionNumber;
      const developerMode = device.deviceProperties?.developerModeStatus;
      const paired = device.connectionProperties?.pairingState === "paired";
      const wired = device.connectionProperties?.transportType === "wired";
      const signingRequired = connected && wired && paired && developerMode === "enabled" && !signing;
      const compatible = connected && wired && paired && developerMode === "enabled" && Boolean(signing);
      const problem = this.physicalDeviceProblem({ connected, wired, paired, developerMode, signing, signingProblem });
      const detail =
        problem ??
        `Connected via USB with signing available. WebDriverAgent bundle ID: ${signing!.bundleId}. Enable UI Automation, Safari Web Inspector, and Remote Automation before the first test.`;
      return [
        {
          id: hardware.udid,
          name,
          ...(version ? { platformVersion: version } : {}),
          state: connected ? (wired ? "Connected" : "Wireless") : "Unavailable",
          deviceKind: "physical" as const,
          compatible,
          detail,
          setupChecks: [
            {
              id: "usb",
              label: "USB connection",
              ready: connected && wired,
              detail: connected && wired ? "Connected directly by USB." : "Connect and unlock the device by USB.",
            },
            {
              id: "trust",
              label: "Xcode device readiness",
              ready: paired,
              detail: paired
                ? "The device is paired and available to Xcode."
                : "Accept “Trust This Computer” and wait for Xcode to finish preparing the device.",
            },
            {
              id: "developer-mode",
              label: "Developer Mode",
              ready: developerMode === "enabled",
              detail:
                developerMode === "enabled"
                  ? "Developer Mode is enabled."
                  : "Enable Developer Mode, restart the device, and confirm it after restart.",
            },
            {
              id: "signing",
              label: "Apple Development signing",
              ready: Boolean(signing),
              detail: signing
                ? "The certificate, private key, and trust chain form a valid signing identity."
                : (signingProblem ?? "Create and validate an Apple Development signing identity."),
            },
          ],
          ...(signingRequired ? { documentationUrl: "/docs#ios-signing" } : {}),
          config: {
            name: "safari-ios" as const,
            deviceKind: "physical" as const,
            deviceName: name,
            ...(version ? { platformVersion: version } : {}),
            udid: hardware.udid,
            ...(signing
              ? { iosTeamId: signing.teamId, iosSigningId: "Apple Development", wdaBundleId: signing.bundleId }
              : {}),
          },
        },
      ];
    });
  }

  static async deviceFingerprint(): Promise<string> {
    const devices = await this.coreDevices();
    return JSON.stringify(
      devices.known
        .filter((device) => device.hardwareProperties?.platform === "iOS")
        .map((device) => ({
          id: device.identifier,
          udid: device.hardwareProperties?.udid,
          available: Boolean(device.identifier && devices.available.has(device.identifier)),
          developerMode: device.deviceProperties?.developerModeStatus,
          paired: device.connectionProperties?.pairingState,
          transport: device.connectionProperties?.transportType,
        }))
        .sort((left, right) => String(left.udid).localeCompare(String(right.udid))),
    );
  }

  private static async simulatorDevices(): Promise<TargetDeviceOption[]> {
    const runtimes = await CommandRunner.run("xcrun", ["simctl", "list", "runtimes", "--json"], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const devices = await CommandRunner.run("xcrun", ["simctl", "list", "devices", "available", "--json"], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
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

  private static async coreDevices(): Promise<{ known: CoreDevice[]; available: Set<string> }> {
    const [known, available] = await Promise.all([this.runDeviceCtl(), this.runDeviceCtl("State == 'available'")]);
    const legacy = known.some((device) => device.connectionProperties?.pairingState === "unsupported")
      ? await this.legacyDevices()
      : { known: [], available: new Set<string>() };
    return {
      known: [...known, ...legacy.known],
      available: new Set([
        ...available.flatMap((device) => (device.identifier ? [device.identifier] : [])),
        ...legacy.available,
      ]),
    };
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

  private static async legacyDevices(): Promise<{ known: CoreDevice[]; available: Set<string> }> {
    const result = await CommandRunner.run("xcrun", ["xcdevice", "list", "--timeout", LEGACY_DEVICE_TIMEOUT_SECONDS], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) return { known: [], available: new Set() };
    try {
      return this.legacyDeviceData(JSON.parse(result.stdout) as XcodeDevice[]);
    } catch {
      return { known: [], available: new Set() };
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

  private static physicalDeviceProblem(input: {
    connected: boolean;
    wired: boolean;
    paired: boolean;
    developerMode?: string;
    signing?: IosSigningConfiguration;
    signingProblem?: string;
  }): string | undefined {
    if (!input.connected) return "Unlock the device, connect it by USB, and keep it connected during setup.";
    if (!input.wired) return "Connect the device directly by USB; wireless iOS connections are not supported yet.";
    if (!input.paired) return "Unlock the device and accept “Trust This Computer”.";
    if (input.developerMode !== "enabled")
      return "Enable Developer Mode under Settings → Privacy & Security, restart the device, and confirm it after restart.";
    if (!input.signing)
      return (
        input.signingProblem ??
        "Add a free Apple Account or paid Developer team in Xcode and prepare WebDriverAgent signing."
      );
    return undefined;
  }

  private static physicalDeviceAction(device: TargetDeviceOption, signingProblem?: string): string {
    if (device.detail?.includes("Developer Mode"))
      return `${device.detail} Then enable UI Automation and Safari Web Inspector.`;
    if (device.detail?.includes("Apple Account")) return signingProblem ?? device.detail;
    return device.detail ?? "Complete the required setup on the device and refresh this page.";
  }
}
