import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidAvdService } from "../../src/setup/android-avd-service.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { DoctorService } from "../../src/setup/doctor-service.js";

const temporaryDirectories: string[] = [];

async function temporarySdk(): Promise<string> {
  const sdkRoot = await mkdtemp(join(tmpdir(), "browser-testbench-avd-"));
  temporaryDirectories.push(sdkRoot);
  return sdkRoot;
}

async function installImage(sdkRoot: string, api: string, tag: string, architecture: string): Promise<void> {
  const image = join(sdkRoot, "system-images", `android-${api}`, tag, architecture);
  await mkdir(image, { recursive: true });
  await writeFile(join(image, "source.properties"), "Pkg.Revision=1\n");
}

describe("AndroidAvdService", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("selects the newest installed Google Play image for the host architecture", async () => {
    const sdkRoot = await temporarySdk();
    await installImage(sdkRoot, "35", "google_apis_playstore", "arm64-v8a");
    await installImage(sdkRoot, "37.1", "google_apis_playstore_ps16k", "arm64-v8a");
    await installImage(sdkRoot, "38", "google_apis", "arm64-v8a");
    await installImage(sdkRoot, "39", "google_apis_playstore", "x86_64");

    await expect(AndroidAvdService.installedSystemImages(sdkRoot, "arm64-v8a")).resolves.toEqual([
      {
        apiLevel: "37.1",
        architecture: "arm64-v8a",
        packageId: "system-images;android-37.1;google_apis_playstore_ps16k;arm64-v8a",
        tag: "google_apis_playstore_ps16k",
      },
      {
        apiLevel: "35",
        architecture: "arm64-v8a",
        packageId: "system-images;android-35;google_apis_playstore;arm64-v8a",
        tag: "google_apis_playstore",
      },
    ]);
  });

  it("selects the newest generic Pixel profile and derives a stable AVD ID", () => {
    const profile = AndroidAvdService.selectPixelProfile("pixel_9_pro\npixel_8\npixel_10\npixel_9\n");

    expect(profile).toBe("pixel_10");
    expect(AndroidAvdService.avdName(profile!, "37.1")).toBe("browser-testbench-pixel-10-api-37-1");
    expect(AndroidAvdService.hostArchitecture("arm64")).toBe("arm64-v8a");
    expect(AndroidAvdService.hostArchitecture("x64")).toBe("x86_64");
  });

  it("reuses an existing compatible AVD instead of creating another one", async () => {
    const sdkRoot = await temporarySdk();
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    await mkdir(join(sdkRoot, "emulator"), { recursive: true });
    await writeFile(emulator, "");
    vi.spyOn(DoctorService, "androidSdkRoot").mockResolvedValue(sdkRoot);
    vi.spyOn(DoctorService, "androidDeviceOptions").mockResolvedValue([
      {
        id: "Pixel_9_API_35",
        name: "Pixel_9_API_35",
        compatible: true,
        config: { name: "chrome-android", avd: "Pixel_9_API_35" },
      },
    ]);
    const run = vi.spyOn(CommandRunner, "run").mockResolvedValue({
      code: 0,
      stdout: "Pixel_9_API_35\n",
      stderr: "",
    });

    await expect(AndroidAvdService.ensure()).resolves.toMatchObject({
      status: "completed",
      detail: "Using existing compatible AVD Pixel_9_API_35.",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("offers image installation only when no compatible image is installed", async () => {
    const sdkRoot = await temporarySdk();
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    const avdManager = join(
      sdkRoot,
      "cmdline-tools",
      "latest",
      "bin",
      process.platform === "win32" ? "avdmanager.bat" : "avdmanager",
    );
    await mkdir(join(sdkRoot, "emulator"), { recursive: true });
    await mkdir(join(sdkRoot, "cmdline-tools", "latest", "bin"), { recursive: true });
    await writeFile(emulator, "");
    await writeFile(avdManager, "");
    vi.spyOn(DoctorService, "androidSdkRoot").mockResolvedValue(sdkRoot);
    vi.spyOn(DoctorService, "androidDeviceOptions").mockResolvedValue([]);
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(AndroidAvdService.plan()).resolves.toMatchObject({
      label: "Google Play system image",
      automatic: false,
      status: "manual",
      detail: expect.stringContaining("Install the latest available image"),
    });
  });

  it("creates a dynamically named AVD from the installed image and Pixel profile", async () => {
    const sdkRoot = await temporarySdk();
    const architecture = AndroidAvdService.hostArchitecture();
    const emulator = join(sdkRoot, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
    const avdManager = join(
      sdkRoot,
      "cmdline-tools",
      "latest",
      "bin",
      process.platform === "win32" ? "avdmanager.bat" : "avdmanager",
    );
    await mkdir(join(sdkRoot, "emulator"), { recursive: true });
    await mkdir(join(sdkRoot, "cmdline-tools", "latest", "bin"), { recursive: true });
    await writeFile(emulator, "");
    await writeFile(avdManager, "");
    await installImage(sdkRoot, "37.1", "google_apis_playstore", architecture);
    vi.spyOn(DoctorService, "androidSdkRoot").mockResolvedValue(sdkRoot);
    vi.spyOn(DoctorService, "androidDeviceOptions").mockResolvedValue([]);
    const run = vi.spyOn(CommandRunner, "run").mockImplementation(async (command, arguments_) => {
      if (command === emulator) return { code: 0, stdout: "", stderr: "" };
      if (arguments_.includes("--compact")) return { code: 0, stdout: "pixel_9\npixel_10\n", stderr: "" };
      return { code: 0, stdout: "Created AVD", stderr: "" };
    });

    await expect(AndroidAvdService.ensure()).resolves.toMatchObject({
      label: "Android AVD browser-testbench-pixel-10-api-37-1",
      status: "completed",
    });
    expect(run).toHaveBeenCalledWith(
      avdManager,
      expect.arrayContaining([
        "--name",
        "browser-testbench-pixel-10-api-37-1",
        "--package",
        `system-images;android-37.1;google_apis_playstore;${architecture}`,
        "--device",
        "pixel_10",
      ]),
      expect.objectContaining({ input: "no\n" }),
    );
  });
});
