import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidUsbNetwork } from "../../src/automation/android-usb-network.js";
import { AndroidSdk } from "../../src/infrastructure/android-sdk.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("AndroidUsbNetwork", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards each local port once and removes it during cleanup", async () => {
    vi.spyOn(AndroidSdk, "root").mockResolvedValue("C:\\Android\\Sdk");
    const run = vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const network = new AndroidUsbNetwork({
      name: "chrome-android",
      deviceKind: "physical",
      deviceName: "Pixel 8",
      udid: "R5CT1234",
    });

    await expect(network.prepare("http://localhost:4173/example")).resolves.toBe("http://127.0.0.1:4173/example");
    await network.prepare("http://127.0.0.1:4173/other");
    await network.close();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/adb(?:\.exe)?$/),
      ["-s", "R5CT1234", "reverse", "tcp:4173", "tcp:4173"],
      expect.any(Object),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/adb(?:\.exe)?$/),
      ["-s", "R5CT1234", "reverse", "--remove", "tcp:4173"],
      expect.any(Object),
    );
  });

  it("does not alter public URLs", async () => {
    const run = vi.spyOn(CommandRunner, "run");
    const network = new AndroidUsbNetwork({ name: "chrome-android", deviceKind: "physical", udid: "R5CT1234" });

    await expect(network.prepare("https://example.com/path")).resolves.toBe("https://example.com/path");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports failed forwarding cleanup", async () => {
    vi.spyOn(AndroidSdk, "root").mockResolvedValue("C:\\Android\\Sdk");
    vi.spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "device offline" });
    const network = new AndroidUsbNetwork({
      name: "chrome-android",
      deviceKind: "physical",
      udid: "R5CT1234",
    });
    await network.prepare("http://localhost:4173/example");

    await expect(network.close()).rejects.toThrow("device offline");
  });
});
