import type { DoctorCheck, TargetDeviceOption } from "../config/types.js";
import { TargetRegistry } from "../config/target-registry.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { IosDeviceDiscovery, type CoreDevice } from "./ios-device-discovery.js";
import { IosSigningService, type IosSigningConfiguration } from "./ios-signing-service.js";

const COMMAND_TIMEOUT_MS = 8_000;
const RECENT_DEVICE_WINDOW_MS = 2 * 60_000;

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

    const [inventory, signing] = await Promise.all([IosDeviceDiscovery.inventory(), IosSigningService.configuration()]);
    const physical = this.physicalDeviceOptions(
      inventory.knownPhysicalDevices,
      inventory.availablePhysicalIdentifiers,
      signing.selected,
      Date.now(),
      signing.problem,
    );
    const devices = [...inventory.simulators, ...physical];
    if (devices.some((device) => device.compatible)) {
      return { id: "safari-ios", label, status: "ready", detail: this.readyDetail(devices), devices };
    }

    const physicalDevice = physical[0];
    if (physicalDevice) {
      return {
        id: "safari-ios",
        label,
        status: "action",
        detail: physicalDevice.detail ?? "A physical Apple device needs attention.",
        action: this.physicalDeviceAction(physicalDevice),
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
      const connected =
        availableIdentifiers.has(hardware.udid) ||
        Boolean(device.identifier && availableIdentifiers.has(device.identifier));
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
              id: "usb" as const,
              label: "USB connection",
              ready: connected && wired,
              detail: connected && wired ? "Connected directly by USB." : "Connect and unlock the device by USB.",
            },
            {
              id: "trust" as const,
              label: "Xcode device readiness",
              ready: paired,
              detail: paired
                ? "The device is paired and available to Xcode."
                : "Accept “Trust This Computer” and wait for Xcode to finish preparing the device.",
            },
            {
              id: "developer-mode" as const,
              label: "Developer Mode",
              ready: developerMode === "enabled",
              detail:
                developerMode === "enabled"
                  ? "Developer Mode is enabled."
                  : "Enable Developer Mode, restart the device, and confirm it after restart.",
            },
            {
              id: "signing" as const,
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

  private static physicalDeviceAction(device: TargetDeviceOption): string {
    const pending = device.setupChecks?.find((check) => !check.ready);
    if (pending?.id === "developer-mode")
      return `${pending.detail} Then enable UI Automation and Safari Web Inspector.`;
    return pending?.detail ?? device.detail ?? "Complete the required setup on the device and refresh this page.";
  }
}
