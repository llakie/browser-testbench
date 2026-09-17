import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { AndroidAvdService } from "../../src/setup/android-avd-service.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { SetupService } from "../../src/setup/setup-service.js";

describe("SetupService Appium status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports installed mobile drivers with their versions", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        xcuitest: { installed: true, version: "12.12.4" },
        uiautomator2: { installed: true, version: "8.7.0" },
      }),
    });

    await expect(SetupService.appiumDriverStatus(["safari-ios", "chrome-android"])).resolves.toEqual([
      { name: "xcuitest", installed: true, version: "12.12.4" },
      { name: "uiautomator2", installed: true, version: "8.7.0" },
    ]);
  });

  it("reports a driver as missing when Appium cannot list it", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 1, stdout: "", stderr: "not installed" });

    await expect(SetupService.appiumDriverStatus(["safari-ios"])).resolves.toEqual([
      { name: "xcuitest", installed: false, version: undefined },
    ]);
  });

  it("associates automatic setup actions with their affected target", async () => {
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(true);
    vi.spyOn(SetupService, "appiumDriverStatus").mockResolvedValue([
      { name: "xcuitest", installed: false },
      { name: "uiautomator2", installed: false },
    ]);
    vi.spyOn(AndroidAvdService, "plan").mockResolvedValue(undefined);
    vi.spyOn(DoctorService, "inspect").mockResolvedValue([]);

    const actions = await SetupService.plan(["safari-ios", "chrome-android"]);

    expect(actions.map((action) => action.targets)).toEqual([["safari-ios"], ["chrome-android"]]);
  });

  it("does not offer Appium installation on an unsupported Node.js runtime", async () => {
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(false);
    vi.spyOn(AndroidAvdService, "plan").mockResolvedValue(undefined);
    vi.spyOn(DoctorService, "inspect").mockResolvedValue([
      {
        id: "node",
        label: "Node.js",
        status: "blocked",
        detail: "v22.5.1",
        action: "Install Node.js 22.12 LTS or Node.js 24 or newer.",
      },
    ]);

    await expect(SetupService.plan(["chrome-android"])).resolves.toEqual([
      expect.objectContaining({ label: "Node.js", automatic: false, status: "manual" }),
    ]);
  });

  it("does not offer emulator provisioning when a compatible USB device is connected", async () => {
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(true);
    vi.spyOn(SetupService, "appiumDriverStatus").mockResolvedValue([
      { name: "uiautomator2", installed: true, version: "8.7.0" },
    ]);
    const avdPlan = vi.spyOn(AndroidAvdService, "plan");
    const checks = [
      {
        id: "chrome-android",
        label: "Chrome on Android",
        status: "ready" as const,
        detail: "1 connected device ready for Chrome testing.",
        devices: [
          {
            id: "R5CT1234",
            name: "Pixel 8",
            deviceKind: "physical" as const,
            compatible: true,
            config: { name: "chrome-android" as const, deviceKind: "physical" as const, udid: "R5CT1234" },
          },
        ],
      },
    ];

    await expect(SetupService.plan(["chrome-android"], checks)).resolves.toEqual([
      expect.objectContaining({ label: "Appium UiAutomator2", status: "completed" }),
    ]);
    expect(avdPlan).not.toHaveBeenCalled();
  });
});
