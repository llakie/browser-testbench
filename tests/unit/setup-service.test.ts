import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { AndroidAvdService } from "../../src/setup/android-avd-service.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { SetupService } from "../../src/setup/setup-service.js";
import { TargetRegistry } from "../../src/config/target-registry.js";

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

  it("reports the exact diagnostic when Appium cannot list installed drivers", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 1, stdout: "", stderr: "not installed" });

    await expect(SetupService.appiumDriverStatus(["safari-ios"])).resolves.toEqual([
      {
        name: "xcuitest",
        installed: false,
        problem: { key: "environment.setupDriverStatusFailed", parameters: { reason: "not installed" } },
      },
    ]);
  });

  it("distinguishes malformed Appium output from a missing driver", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 0, stdout: "not-json", stderr: "" });

    await expect(SetupService.appiumDriverStatus(["chrome-android"])).resolves.toEqual([
      {
        name: "uiautomator2",
        installed: false,
        problem: { key: "environment.setupDriverStatusInvalid", parameters: { output: "not-json" } },
      },
    ]);
  });

  it("surfaces an Appium inspection failure instead of offering a misleading installation", async () => {
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(true);
    vi.spyOn(SetupService, "appiumDriverStatus").mockResolvedValue([
      {
        name: "uiautomator2",
        installed: false,
        problem: { key: "environment.setupDriverStatusFailed", parameters: { reason: "permission denied" } },
      },
    ]);
    vi.spyOn(AndroidAvdService, "plan").mockResolvedValue(undefined);
    vi.spyOn(DoctorService, "inspect").mockResolvedValue([]);

    await expect(SetupService.plan(["chrome-android"])).resolves.toEqual([
      expect.objectContaining({
        label: "Appium UiAutomator2",
        automatic: false,
        status: "failed",
        detail: {
          key: "environment.setupDriverStatusFailed",
          parameters: { reason: "permission denied" },
        },
      }),
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

  it.each([
    {
      name: "stdout when stderr is empty",
      result: { code: 1, stdout: "npm certificate validation failed", stderr: "" },
      detail: "npm certificate validation failed",
    },
    {
      name: "the exit code when the command has no output",
      result: { code: 23, stdout: "", stderr: "" },
      detail: { key: "environment.setupDriverInstallExited", parameters: { code: 23 } },
    },
  ])("reports $name for a failed Appium installation", async ({ result, detail }) => {
    vi.spyOn(TargetRegistry, "isSupported").mockReturnValue(true);
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(true);
    vi.spyOn(SetupService, "appiumDriverStatus").mockResolvedValue([{ name: "xcuitest", installed: false }]);
    vi.spyOn(CommandRunner, "run").mockResolvedValue(result);
    vi.spyOn(DoctorService, "inspect").mockResolvedValue([]);

    await expect(SetupService.install(["safari-ios"])).resolves.toEqual([
      expect.objectContaining({ status: "failed", detail }),
    ]);
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

  it("surfaces physical iOS prerequisites through the existing setup actions", async () => {
    vi.spyOn(TargetRegistry, "isSupported").mockReturnValue(true);
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(true);
    vi.spyOn(SetupService, "appiumDriverStatus").mockResolvedValue([
      { name: "xcuitest", installed: true, version: "12.12.4" },
    ]);
    const checks = [
      {
        id: "safari-ios",
        label: "Safari on iOS",
        status: "ready" as const,
        detail: "1 simulator ready for Safari testing.",
        devices: [
          {
            id: "00008140-DEVICE",
            name: "iPhone 17 Pro",
            deviceKind: "physical" as const,
            compatible: false,
            detail: "Enable Developer Mode on the connected device.",
            config: { name: "safari-ios" as const, deviceKind: "physical" as const },
          },
        ],
      },
    ];

    await expect(SetupService.plan(["safari-ios"], checks)).resolves.toEqual([
      expect.objectContaining({ label: "Appium XCUITest", status: "completed" }),
      expect.objectContaining({
        label: { key: "environment.setupSafariOn", parameters: { deviceName: "iPhone 17 Pro" } },
        status: "manual",
        detail: expect.stringContaining("Developer Mode"),
      }),
    ]);
  });

  it("opens WebDriverAgent for a physical iOS signing action", async () => {
    vi.spyOn(TargetRegistry, "isSupported").mockReturnValue(true);
    vi.spyOn(DoctorService, "isNodeSupported").mockReturnValue(true);
    vi.spyOn(SetupService, "appiumDriverStatus").mockResolvedValue([
      { name: "xcuitest", installed: true, version: "12.12.4" },
    ]);
    const checks = [
      {
        id: "safari-ios",
        label: "Safari on iOS",
        status: "ready" as const,
        detail: "1 simulator ready for Safari testing. 1 physical device needs attention.",
        devices: [
          {
            id: "00008140-DEVICE",
            name: "iPhone",
            deviceKind: "physical" as const,
            compatible: false,
            detail: "No Apple Development signing identity is available.",
            documentationUrl: "/docs#ios-signing",
            setupChecks: [
              {
                id: "signing" as const,
                label: "Apple Development signing",
                ready: false,
                detail: "No Apple Development signing identity is available.",
              },
            ],
            config: { name: "safari-ios" as const, deviceKind: "physical" as const },
          },
        ],
      },
    ];

    await expect(SetupService.plan(["safari-ios"], checks)).resolves.toEqual([
      expect.objectContaining({ label: "Appium XCUITest", status: "completed" }),
      expect.objectContaining({
        label: { key: "environment.setupSafariOn", parameters: { deviceName: "iPhone" } },
        command: expect.stringContaining("open-wda"),
      }),
    ]);
  });
});
