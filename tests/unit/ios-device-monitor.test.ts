import { afterEach, describe, expect, it, vi } from "vitest";
import { IosDeviceService } from "../../src/setup/ios-device-service.js";
import { IosDeviceMonitor } from "../../src/setup/ios-device-monitor.js";

describe("IosDeviceMonitor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("notifies only after the physical-device fingerprint changes", async () => {
    let fingerprint = "device:connected";
    vi.spyOn(IosDeviceService, "deviceFingerprint").mockImplementation(async () => fingerprint);
    const changed = vi.fn();
    const monitor = new IosDeviceMonitor(changed);

    await monitor.checkNow();
    await monitor.checkNow();
    expect(changed).not.toHaveBeenCalled();

    fingerprint = "device:disconnected";
    await monitor.checkNow();
    expect(changed).toHaveBeenCalledOnce();
  });
});
