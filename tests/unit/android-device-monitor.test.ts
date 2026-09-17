import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidSdk } from "../../src/infrastructure/android-sdk.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { AndroidDeviceMonitor } from "../../src/setup/android-device-monitor.js";

describe("AndroidDeviceMonitor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("notifies only after the normalized ADB device list changes", async () => {
    vi.spyOn(AndroidSdk, "root").mockResolvedValue("C:\\Android\\Sdk");
    let output = "List of devices attached\nR5CT1234 device model:Pixel_8\n";
    vi.spyOn(CommandRunner, "run").mockImplementation(async () => ({ code: 0, stdout: output, stderr: "" }));
    const changed = vi.fn();
    const monitor = new AndroidDeviceMonitor(changed);

    await monitor.checkNow();
    await monitor.checkNow();
    expect(changed).not.toHaveBeenCalled();

    output = "List of devices attached\n";
    await monitor.checkNow();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("normalizes ordering and ignores ADB daemon messages", () => {
    expect(
      AndroidDeviceMonitor.normalizeDeviceList(
        "* daemon started successfully *\nList of devices attached\nB offline\nA device model:Pixel_8\n",
      ),
    ).toBe("A device model:Pixel_8\nB offline");
  });
});
