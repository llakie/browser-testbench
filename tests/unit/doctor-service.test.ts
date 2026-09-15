import { describe, expect, it } from "vitest";
import { DoctorService } from "../../src/setup/doctor-service.js";

describe("DoctorService device discovery", () => {
  it("preserves every available iOS simulator as a selectable project target", () => {
    const devices = DoctorService.iosDeviceOptions(
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
