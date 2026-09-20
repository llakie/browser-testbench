import { describe, expect, it } from "vitest";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { IosDeviceService } from "../../src/setup/ios-device-service.js";

describe("DoctorService device discovery", () => {
  it.each([
    ["22.11.0", false],
    ["22.12.0", true],
    ["23.11.0", false],
    ["24.0.0", true],
  ])("checks whether Node.js %s can run the bundled dependencies", (version, supported) => {
    expect(DoctorService.isNodeSupported(version)).toBe(supported);
  });

  it("preserves every available iOS simulator as a selectable project target", () => {
    const devices = IosDeviceService.simulatorDeviceOptions(
      [{ identifier: "runtime-26-5", name: "iOS 26.5", version: "26.5" }],
      {
        "runtime-26-5": [
          { name: "iPhone 17 Pro", udid: "PRO-ID", state: "Shutdown", isAvailable: true },
          { name: "iPhone 13 mini", udid: "MINI-ID", state: "Booted", isAvailable: true },
        ],
      },
    );

    expect(devices).toHaveLength(2);
    expect(devices[1]).toMatchObject({
      name: "iPhone 13 mini",
      platformVersion: "26.5",
      config: {
        name: "safari-ios",
        deviceName: "iPhone 13 mini",
        platformVersion: "26.5",
        udid: "MINI-ID",
      },
    });
  });
});
