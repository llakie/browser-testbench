import { describe, expect, it } from "vitest";
import type { DoctorCheck, TargetDeviceOption } from "../../src/config/types.js";
import type { WorkbenchState } from "../../src/setup/workbench-types.js";
import { DeviceSetupSteps } from "../../src/ui/client/components/device-setup-steps.js";

describe("DeviceSetupSteps", () => {
  it("uses stable setup action IDs instead of their display labels", () => {
    const workbench = state({
      actions: [
        {
          id: "appium-xcuitest",
          label: "Translated driver label",
          automatic: true,
          status: "completed",
          targets: ["safari-ios"],
        },
      ],
    });
    const check = iosCheck();
    const device = check.devices![0];

    expect(DeviceSetupSteps.ios(workbench, check, device, true)[0]).toMatchObject({ id: "tools", ready: true });
  });

  it("marks only the selected physical device as verified", () => {
    const check = iosCheck();
    const selected = check.devices![0];
    const workbench = state({
      testTargets: [
        {
          id: "safari-ios-other",
          browser: "safari-ios",
          label: "Other iPhone",
          kind: "mobile",
          status: "ready",
          ready: true,
          serial: true,
          deviceKind: "physical",
          deviceId: "OTHER-DEVICE",
          detail: "Ready",
          verifiedAt: new Date().toISOString(),
        },
      ],
    });

    expect(DeviceSetupSteps.ios(workbench, check, selected, true).at(-1)).toMatchObject({ id: "test", ready: false });
  });

  it("keeps Android verification scoped to the selected device", () => {
    const selected: TargetDeviceOption = {
      id: "SELECTED-ANDROID",
      name: "Selected Android",
      deviceKind: "physical",
      state: "Connected",
      compatible: true,
      config: { name: "chrome-android", deviceKind: "physical", udid: "SELECTED-ANDROID" },
    };
    const check: DoctorCheck = {
      id: "chrome-android",
      label: "Chrome on Android",
      status: "ready",
      detail: "Ready",
      devices: [selected],
    };
    const workbench = state({
      testTargets: [
        {
          id: "chrome-android-other",
          browser: "chrome-android",
          label: "Other Android",
          kind: "mobile",
          status: "ready",
          ready: true,
          serial: true,
          deviceKind: "physical",
          deviceId: "OTHER-ANDROID",
          detail: "Ready",
          verifiedAt: new Date().toISOString(),
        },
      ],
    });

    expect(DeviceSetupSteps.android(workbench, check, selected).at(-1)).toMatchObject({ id: "test", ready: false });
  });
});

function iosCheck(): DoctorCheck {
  const device: TargetDeviceOption = {
    id: "SELECTED-DEVICE",
    name: "Selected iPhone",
    deviceKind: "physical",
    state: "Connected",
    compatible: true,
    setupChecks: [
      { id: "usb", label: "USB", ready: true, detail: "Ready" },
      { id: "trust", label: "Trust", ready: true, detail: "Ready" },
      { id: "developer-mode", label: "Developer Mode", ready: true, detail: "Ready" },
      { id: "signing", label: "Signing", ready: true, detail: "Ready" },
    ],
    config: { name: "safari-ios", deviceKind: "physical", udid: "SELECTED-DEVICE" },
  };
  return { id: "safari-ios", label: "Safari on iOS", status: "ready", detail: "Ready", devices: [device] };
}

function state(overrides: Partial<WorkbenchState>): WorkbenchState {
  return {
    platform: "darwin",
    platformLabel: "macOS",
    architecture: "arm64",
    mcpClients: [],
    targets: [],
    checks: [],
    actions: [],
    testTargets: [],
    clientInstallCommand: "npm install",
    packageName: "browser-testbench",
    connection: { mode: "local", reachable: true },
    permissions: { control: true, configure: true },
    remoteMode: false,
    pairingRequests: [],
    authorizedClients: [],
    ...overrides,
  };
}
