import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidSdk } from "../../src/infrastructure/android-sdk.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { AndroidDeviceService } from "../../src/setup/android-device-service.js";

const temporaryDirectories: string[] = [];

describe("AndroidDeviceService", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("parses physical device states and ignores running emulators", () => {
    const devices = AndroidDeviceService.parseAdbDevices(`List of devices attached
R5CT1234 device product:husky model:Pixel_8 device:husky transport_id:1
ZY22 offline transport_id:2
ABC unauthorized usb:1-2
LINUX no permissions (user in plugdev group)
emulator-5554 device product:sdk_gphone64_x86_64
`);

    expect(devices).toEqual([
      expect.objectContaining({
        serial: "R5CT1234",
        state: "device",
        attributes: { product: "husky", model: "Pixel_8", device: "husky", transport_id: "1" },
      }),
      expect.objectContaining({ serial: "ZY22", state: "offline" }),
      expect.objectContaining({ serial: "ABC", state: "unauthorized" }),
      expect.objectContaining({ serial: "LINUX", state: "no permissions" }),
      expect.objectContaining({ serial: "emulator-5554", state: "device" }),
    ]);
  });

  it("detects an authorized USB device with Chrome as a ready target without an emulator", async () => {
    const sdkRoot = await temporarySdk();
    const adb = AndroidSdk.adb(sdkRoot);
    await mkdir(join(sdkRoot, "platform-tools"), { recursive: true });
    await writeFile(adb, "");
    vi.spyOn(AndroidSdk, "root").mockResolvedValue(sdkRoot);
    vi.spyOn(CommandRunner, "run").mockImplementation(async (_command, args = []) => {
      if (args[0] === "devices") {
        return { code: 0, stdout: "List of devices attached\nR5CT1234 device model:Pixel_8\n", stderr: "" };
      }
      if (args.includes("ro.product.model")) return { code: 0, stdout: "Pixel 8\n", stderr: "" };
      if (args.includes("ro.build.version.release")) return { code: 0, stdout: "16\n", stderr: "" };
      if (args.includes("com.android.chrome")) {
        return { code: 0, stdout: "package:/data/app/com.android.chrome/base.apk\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    await expect(AndroidDeviceService.inspect()).resolves.toMatchObject({
      status: "ready",
      detail: "1 connected device ready for Chrome testing.",
      devices: [
        {
          id: "R5CT1234",
          name: "Pixel 8",
          platformVersion: "16",
          state: "Connected",
          deviceKind: "physical",
          compatible: true,
          config: {
            name: "chrome-android",
            deviceKind: "physical",
            deviceName: "Pixel 8",
            platformVersion: "16",
            udid: "R5CT1234",
          },
        },
      ],
    });
  });

  it("explains how to authorize a detected USB device", async () => {
    const sdkRoot = await temporarySdk();
    const adb = AndroidSdk.adb(sdkRoot);
    await mkdir(join(sdkRoot, "platform-tools"), { recursive: true });
    await writeFile(adb, "");
    vi.spyOn(AndroidSdk, "root").mockResolvedValue(sdkRoot);
    vi.spyOn(CommandRunner, "run").mockResolvedValue({
      code: 0,
      stdout: "List of devices attached\nR5CT1234 unauthorized model:Pixel_8\n",
      stderr: "",
    });

    await expect(AndroidDeviceService.inspect()).resolves.toMatchObject({
      status: "action",
      action: "Unlock the device and accept the USB debugging authorization prompt.",
      devices: [expect.objectContaining({ state: "unauthorized", compatible: false })],
    });
  });

  it("includes a detected physical device that needs attention in the ready summary", () => {
    expect(
      AndroidDeviceService.readyDetail([
        {
          id: "emulator-1",
          name: "Pixel Emulator",
          deviceKind: "emulator",
          compatible: true,
          config: { name: "chrome-android", deviceKind: "emulator", avd: "Pixel_Emulator" },
        },
        {
          id: "physical-1",
          name: "Pixel 8",
          deviceKind: "physical",
          compatible: false,
          config: { name: "chrome-android", deviceKind: "physical", udid: "physical-1" },
        },
      ]),
    ).toBe("1 emulator ready for Chrome testing. 1 physical device needs attention.");
  });

  it("reads an AVD version from Windows-style SDK paths", async () => {
    const avdHome = await mkdtemp(join(tmpdir(), "browser-testbench-avd-home-"));
    temporaryDirectories.push(avdHome);
    const avdDirectory = join(avdHome, "Pixel_10.avd");
    await mkdir(avdDirectory, { recursive: true });
    await writeFile(join(avdHome, "Pixel_10.ini"), `path=${avdDirectory}\n`);
    await writeFile(
      join(avdDirectory, "config.ini"),
      "image.sysdir.1=system-images\\android-37.2\\google_apis_playstore_ps16k\\x86_64\\\ntag.id=google_apis_playstore_ps16k\n",
    );
    const previousAvdHome = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = avdHome;

    try {
      await expect(AndroidDeviceService.avdOptions(["Pixel_10"])).resolves.toEqual([
        expect.objectContaining({ platformVersion: "37.2", deviceKind: "emulator", compatible: true }),
      ]);
    } finally {
      if (previousAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
      else process.env.ANDROID_AVD_HOME = previousAvdHome;
    }
  });

  it("recognizes Google Play across all AVD tag configuration entries", async () => {
    const avdHome = await mkdtemp(join(tmpdir(), "browser-testbench-avd-home-"));
    temporaryDirectories.push(avdHome);
    const avdDirectory = join(avdHome, "Pixel_8_Pro_API_36.avd");
    await mkdir(avdDirectory, { recursive: true });
    await writeFile(join(avdHome, "Pixel_8_Pro_API_36.ini"), `path=${avdDirectory}\n`);
    await writeFile(
      join(avdDirectory, "config.ini"),
      "image.sysdir.1=system-images\\android-36\\google_apis_playstore_16k\\x86_64\\\n" +
        "tag.id=google_apis\ntag.ids=page_size_16kx,google_apis_playstore\nPlayStore.enabled=true\n",
    );
    const previousAvdHome = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = avdHome;

    try {
      await expect(AndroidDeviceService.avdOptions(["Pixel_8_Pro_API_36"])).resolves.toEqual([
        expect.objectContaining({ platformVersion: "36", deviceKind: "emulator", compatible: true }),
      ]);
    } finally {
      if (previousAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
      else process.env.ANDROID_AVD_HOME = previousAvdHome;
    }
  });
});

async function temporarySdk(): Promise<string> {
  const sdkRoot = await mkdtemp(join(tmpdir(), "browser-testbench-android-device-"));
  temporaryDirectories.push(sdkRoot);
  return sdkRoot;
}
