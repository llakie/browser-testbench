import type { DoctorCheck, TargetDeviceOption } from "../config/types.js";
import type { TranslatableText } from "../i18n/translator.js";
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
        detail: { key: "environment.xcodeMissing" },
        action: { key: "environment.xcodeInstall" },
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
      return {
        id: "safari-ios",
        label,
        status: "ready",
        detail: this.readyMessage(devices),
        devices,
      };
    }

    const physicalDevice = physical[0];
    if (physicalDevice) {
      return {
        id: "safari-ios",
        label,
        status: "action",
        detail: physicalDevice.detail ?? { key: "environment.iosPhysicalAttention" },
        action: this.physicalDeviceAction(physicalDevice),
        devices,
      };
    }
    return {
      id: "safari-ios",
      label,
      status: "action",
      detail: { key: "environment.iosNone" },
      action: { key: "environment.iosConnect" },
    };
  }

  static physicalDeviceOptions(
    known: CoreDevice[],
    availableIdentifiers: Set<string>,
    signing?: IosSigningConfiguration,
    now = Date.now(),
    signingProblem?: TranslatableText,
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
      const detail = problem ?? {
        key: "environment.iosReady" as const,
        parameters: { bundleId: signing?.bundleId ?? "" },
      };
      let state = "Unavailable";
      if (connected) state = wired ? "Connected" : "Wireless";
      const usbReady = connected && wired;
      const developerModeReady = developerMode === "enabled";
      let signingDetail: TranslatableText = { key: "environment.iosSigning" };
      if (signing) signingDetail = { key: "environment.iosSigningReady" };
      else if (signingProblem) signingDetail = signingProblem;
      const option: TargetDeviceOption = {
        id: hardware.udid,
        name,
        state,
        deviceKind: "physical",
        compatible,
        detail,
        setupChecks: [
          {
            id: "usb",
            label: { key: "environment.iosUsbLabel" },
            ready: usbReady,
            detail: { key: usbReady ? "environment.iosUsbReady" : "environment.iosUsbConnect" },
          },
          {
            id: "trust",
            label: { key: "environment.iosTrustLabel" },
            ready: paired,
            detail: { key: paired ? "environment.iosTrustReady" : "environment.iosTrust" },
          },
          {
            id: "developer-mode",
            label: { key: "environment.iosDeveloperLabel" },
            ready: developerModeReady,
            detail: { key: developerModeReady ? "environment.iosDeveloperReady" : "environment.iosDeveloper" },
          },
          {
            id: "signing",
            label: { key: "environment.iosSigningLabel" },
            ready: Boolean(signing),
            detail: signingDetail,
          },
        ],
        config: {
          name: "safari-ios",
          deviceKind: "physical",
          deviceName: name,
          udid: hardware.udid,
        },
      };
      if (version) {
        option.platformVersion = version;
        option.config.platformVersion = version;
      }
      if (signingRequired) option.documentationUrl = "/docs#ios-signing";
      if (signing) {
        option.config.iosTeamId = signing.teamId;
        option.config.iosSigningId = "Apple Development";
        option.config.wdaBundleId = signing.bundleId;
      }
      return [option];
    });
  }

  private static physicalDeviceProblem(input: {
    connected: boolean;
    wired: boolean;
    paired: boolean;
    developerMode?: string;
    signing?: IosSigningConfiguration;
    signingProblem?: TranslatableText;
  }): TranslatableText | undefined {
    if (!input.connected) return { key: "environment.iosUnlock" };
    if (!input.wired) return { key: "environment.iosWired" };
    if (!input.paired) return { key: "environment.iosTrust" };
    if (input.developerMode !== "enabled") return { key: "environment.iosDeveloper" };
    if (!input.signing) return input.signingProblem ?? { key: "environment.iosAccount" };
    return undefined;
  }

  private static physicalDeviceAction(device: TargetDeviceOption): TranslatableText {
    const pending = device.setupChecks?.find((check) => !check.ready);
    if (pending?.id === "developer-mode") return { key: "environment.iosDeveloperAction" };
    return pending?.detail ?? device.detail ?? { key: "environment.iosCompleteSetup" };
  }

  static readyMessage(devices: TargetDeviceOption[]) {
    const count = devices.filter((device) => device.compatible).length;
    const attention = devices.filter((device) => device.deviceKind === "physical" && !device.compatible).length;
    let key: "environment.iosTargetsReady" | "environment.iosTargetsReadyAttention" = "environment.iosTargetsReady";
    if (attention > 0) key = "environment.iosTargetsReadyAttention";
    return {
      key,
      parameters: { count, attention },
      count,
    };
  }
}
