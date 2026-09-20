import { afterEach, describe, expect, it, vi } from "vitest";
import { IosDeviceDiscovery } from "../../src/setup/ios-device-discovery.js";
import { IosDeviceMonitor } from "../../src/setup/ios-device-monitor.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("IosDeviceMonitor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("notifies only after the physical-device fingerprint changes", async () => {
    let fingerprint = "device:connected";
    vi.spyOn(IosDeviceDiscovery, "fingerprint").mockImplementation(async () => fingerprint);
    const changed = vi.fn();
    const monitor = new IosDeviceMonitor(changed);

    await monitor.checkNow();
    await monitor.checkNow();
    expect(changed).not.toHaveBeenCalled();

    fingerprint = "device:disconnected";
    await monitor.checkNow();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("builds its polling fingerprint from one bounded xcdevice query", async () => {
    const run = vi.spyOn(CommandRunner, "run").mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          identifier: "DEVICE-ID",
          available: true,
          simulator: false,
          platform: "com.apple.platform.iphoneos",
          interface: "usb",
          operatingSystemVersion: "16.7.11",
        },
      ]),
    });

    await expect(IosDeviceDiscovery.fingerprint()).resolves.toContain("DEVICE-ID");
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("xcrun", ["xcdevice", "list", "--timeout", "1"], expect.any(Object));
  });
});
