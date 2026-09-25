import { afterEach, describe, expect, it, vi } from "vitest";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { IosDeviceDiscovery } from "../../src/setup/ios-device-discovery.js";
import { MediaTooling } from "../../src/infrastructure/media-tooling.js";
import { AndroidDeviceService } from "../../src/setup/android-device-service.js";

describe("DoctorService device discovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["22.11.0", false],
    ["22.12.0", true],
    ["23.11.0", false],
    ["24.0.0", true],
  ])("checks whether Node.js %s can run the bundled dependencies", (version, supported) => {
    expect(DoctorService.isNodeSupported(version)).toBe(supported);
  });

  it("preserves every available iOS simulator as a selectable project target", () => {
    const devices = IosDeviceDiscovery.simulatorDeviceOptions(
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

  it("adds media tooling to guided setup for mobile targets", async () => {
    vi.spyOn(MediaTooling, "missing").mockReturnValue(["ffmpeg", "ffprobe"]);
    vi.spyOn(MediaTooling, "installationCommand").mockReturnValue("install ffmpeg");
    vi.spyOn(AndroidDeviceService, "inspect").mockResolvedValue({
      id: "chrome-android",
      label: "Chrome on Android",
      status: "ready",
      detail: "ready",
    });

    await expect(DoctorService.inspect(["chrome-android"])).resolves.toContainEqual({
      id: "media-tooling",
      label: { key: "environment.mediaToolingLabel" },
      status: "action",
      detail: { key: "environment.mediaToolingMissing", parameters: { tools: "ffmpeg, ffprobe" } },
      action: { key: "environment.mediaToolingAction" },
      commands: ["install ffmpeg"],
    });
  });

  it("does not require media tooling for desktop-only targets", async () => {
    vi.spyOn(MediaTooling, "missing");

    const checks = await DoctorService.inspect([]);

    expect(checks.map((check) => check.id)).toEqual(["node"]);
    expect(MediaTooling.missing).not.toHaveBeenCalled();
  });
});
