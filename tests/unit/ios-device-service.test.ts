import { describe, expect, it } from "vitest";
import { IosDeviceService } from "../../src/setup/ios-device-service.js";
import { IosDeviceDiscovery } from "../../src/setup/ios-device-discovery.js";
import { Translator } from "../../src/i18n/translator.js";

describe("IosDeviceService", () => {
  const device = {
    identifier: "core-device-id",
    connectionProperties: {
      lastConnectionDate: "2026-09-20T10:00:00.000Z",
      pairingState: "paired",
      transportType: "wired",
    },
    deviceProperties: {
      developerModeStatus: "enabled",
      name: "My iPhone",
      osVersionNumber: "26.0",
    },
    hardwareProperties: {
      deviceType: "iPhone",
      marketingName: "iPhone 17 Pro",
      platform: "iOS",
      reality: "physical",
      udid: "00008140-DEVICE",
    },
  };

  it("creates a signed Safari target for a connected physical iPhone", () => {
    const [option] = IosDeviceService.physicalDeviceOptions(
      [device],
      new Set(["core-device-id"]),
      {
        name: "Apple Development: Test",
        teamId: "A1B2C3D4E5",
        bundleId: "com.browser-testbench.WebDriverAgentRunner.a1b2c3d4e5",
      },
      Date.parse("2026-09-20T10:00:30.000Z"),
    );

    expect(option).toMatchObject({
      name: "iPhone 17 Pro",
      platformVersion: "26.0",
      state: "Connected",
      deviceKind: "physical",
      compatible: true,
      setupChecks: [
        expect.objectContaining({ id: "usb", ready: true }),
        expect.objectContaining({ id: "trust", ready: true }),
        expect.objectContaining({ id: "developer-mode", ready: true }),
        expect.objectContaining({ id: "signing", ready: true }),
      ],
      config: {
        name: "safari-ios",
        deviceKind: "physical",
        udid: "00008140-DEVICE",
        iosTeamId: "A1B2C3D4E5",
        iosSigningId: "Apple Development",
      },
    });
  });

  it("explains Developer Mode before exposing an unprepared device as a target", () => {
    const [option] = IosDeviceService.physicalDeviceOptions(
      [{ ...device, deviceProperties: { ...device.deviceProperties, developerModeStatus: "disabled" } }],
      new Set(["core-device-id"]),
      undefined,
      Date.parse("2026-09-20T10:00:30.000Z"),
    );

    expect(option).toMatchObject({
      compatible: false,
      setupChecks: expect.arrayContaining([expect.objectContaining({ id: "developer-mode", ready: false })]),
    });
    expect(new Translator("en").text(option?.detail)).toContain("Developer Mode");
    expect(option?.documentationUrl).toBeUndefined();
  });

  it("links an otherwise prepared device without a signing identity to the signing guide", () => {
    const [option] = IosDeviceService.physicalDeviceOptions(
      [device],
      new Set(["core-device-id"]),
      undefined,
      Date.parse("2026-09-20T10:00:30.000Z"),
      "No Apple Development signing identity is available.",
    );

    expect(option).toMatchObject({
      compatible: false,
      detail: expect.stringContaining("signing identity"),
      documentationUrl: "/docs#ios-signing",
    });
  });

  it("includes a detected physical device that needs attention in the ready summary", () => {
    const simulators = IosDeviceDiscovery.simulatorDeviceOptions(
      [{ identifier: "runtime", version: "26.5", isAvailable: true, name: "iOS 26.5" }],
      {
        runtime: [
          { name: "iPhone 17", udid: "simulator-1", isAvailable: true },
          { name: "iPad", udid: "simulator-2", isAvailable: true },
        ],
      },
    );
    const [physical] = IosDeviceService.physicalDeviceOptions(
      [{ ...device, deviceProperties: { ...device.deviceProperties, developerModeStatus: "disabled" } }],
      new Set(["core-device-id"]),
      undefined,
      Date.parse("2026-09-20T10:00:30.000Z"),
    );

    expect(new Translator("en").text(IosDeviceService.readyMessage([...simulators, physical!]))).toBe(
      "2 iOS test targets are ready for Safari testing; physical devices requiring attention: 1.",
    );
  });

  it("does not surface stale disconnected devices", () => {
    expect(
      IosDeviceService.physicalDeviceOptions([device], new Set(), undefined, Date.parse("2026-09-20T10:10:00.000Z")),
    ).toEqual([]);
  });

  it("maps an available legacy Xcode device to a wired physical iPhone", () => {
    const legacy = IosDeviceDiscovery.legacyDeviceData(
      [
        {
          identifier: "legacy-device-id",
          name: "My iPhone",
          available: true,
          simulator: false,
          platform: "com.apple.platform.iphoneos",
          interface: "usb",
          operatingSystemVersion: "16.7.11 (20H360)",
          modelName: "iPhone X (Model A1865, A1901, A1902, A1903)",
        },
      ],
      Date.parse("2026-09-20T10:00:00.000Z"),
    );

    expect(legacy.available).toEqual(new Set(["legacy-device-id"]));
    expect(legacy.known).toEqual([
      expect.objectContaining({
        identifier: "legacy-device-id",
        connectionProperties: expect.objectContaining({ pairingState: "paired", transportType: "wired" }),
        deviceProperties: expect.objectContaining({ developerModeStatus: "enabled", osVersionNumber: "16.7.11" }),
        hardwareProperties: expect.objectContaining({
          marketingName: "iPhone X (Model A1865, A1901, A1902, A1903)",
          platform: "iOS",
          reality: "physical",
          udid: "legacy-device-id",
        }),
      }),
    ]);
  });

  it("ignores unavailable and simulated Xcode devices in the legacy fallback", () => {
    expect(
      IosDeviceDiscovery.legacyDeviceData([
        {
          identifier: "offline-device",
          available: false,
          simulator: false,
          platform: "com.apple.platform.iphoneos",
        },
        {
          identifier: "simulator",
          available: true,
          simulator: true,
          platform: "com.apple.platform.iphonesimulator",
        },
      ]),
    ).toEqual({ known: [], available: new Set() });
  });
});
