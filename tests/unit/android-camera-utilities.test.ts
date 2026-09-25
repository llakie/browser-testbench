import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidCameraUtilities } from "../../src/automation/android-camera-utilities.js";
import { AndroidSdk } from "../../src/infrastructure/android-sdk.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("AndroidCameraUtilities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("grants and restores the discovered browser package permission on the reserved serial", async () => {
    vi.spyOn(AndroidSdk, "root").mockResolvedValue("/android/sdk");
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "android.permission.CAMERA: granted=false", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "android.permission.CAMERA: granted=true", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const permissions = new AndroidCameraUtilities(
      { name: "chrome-android", udid: "emulator-5554", deviceKind: "emulator" },
      { "appium:chromeOptions": { androidPackage: "org.chromium.chrome" } },
    );

    await expect(permissions.grant(["camera"])).resolves.toEqual({
      packageName: "org.chromium.chrome",
      permissions: ["camera"],
    });
    await permissions.restore();

    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["-s", "emulator-5554", "shell", "dumpsys", "package", "org.chromium.chrome"],
      ["-s", "emulator-5554", "shell", "pm", "grant", "org.chromium.chrome", "android.permission.CAMERA"],
      ["-s", "emulator-5554", "shell", "dumpsys", "package", "org.chromium.chrome"],
      ["-s", "emulator-5554", "shell", "pm", "revoke", "org.chromium.chrome", "android.permission.CAMERA"],
    ]);
  });

  it("discovers a non-default browser package through Android", async () => {
    vi.spyOn(AndroidSdk, "root").mockResolvedValue("/android/sdk");
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "com.vendor.browser/.Main\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "android.permission.CAMERA: granted=true", stderr: "" });
    const permissions = new AndroidCameraUtilities(
      { name: "chrome-android", udid: "emulator-5554", deviceKind: "emulator" },
      {},
    );

    await expect(permissions.grant(["camera"])).resolves.toMatchObject({ packageName: "com.vendor.browser" });
    expect(run).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["com.android.chrome"]),
      expect.anything(),
    );
  });

  it("uses the runtime serial for an emulator target configured by AVD", async () => {
    vi.spyOn(AndroidSdk, "root").mockResolvedValue("/android/sdk");
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "android.permission.CAMERA: granted=true", stderr: "" });
    const permissions = new AndroidCameraUtilities(
      { name: "chrome-android", avd: "Browser_Testbench_API_36", deviceKind: "emulator" },
      { deviceUDID: "emulator-5554", "appium:chromeOptions": { androidPackage: "com.android.chrome" } },
    );

    await permissions.grant(["camera"]);

    expect(run).toHaveBeenCalledWith(
      "/android/sdk/platform-tools/adb",
      ["-s", "emulator-5554", "shell", "dumpsys", "package", "com.android.chrome"],
      expect.anything(),
    );
  });
});
