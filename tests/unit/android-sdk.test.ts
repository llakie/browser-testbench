import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AndroidSdk } from "../../src/infrastructure/android-sdk.js";

describe("AndroidSdk", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("uses an explicitly configured SDK and exports both Appium variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-testbench-android-sdk-"));
    temporaryDirectories.push(root);

    await expect(AndroidSdk.root({ ANDROID_HOME: root }, "linux")).resolves.toBe(root);
    expect(AndroidSdk.environment(root)).toEqual({ ANDROID_HOME: root, ANDROID_SDK_ROOT: root });
  });

  it("detects the conventional Linux SDK and POSIX Android tool names", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-testbench-linux-home-"));
    temporaryDirectories.push(home);
    const sdkRoot = join(home, "Android", "Sdk");
    await mkdir(sdkRoot, { recursive: true });

    await expect(AndroidSdk.root({ HOME: home }, "linux")).resolves.toBe(sdkRoot);
    expect(AndroidSdk.executableName("emulator", ".exe", "linux")).toBe("emulator");
    expect(AndroidSdk.executableName("avdmanager", ".bat", "linux")).toBe("avdmanager");
  });

  it("uses the native Windows Android tool suffixes", () => {
    expect(AndroidSdk.executableName("emulator", ".exe", "win32")).toBe("emulator.exe");
    expect(AndroidSdk.executableName("avdmanager", ".bat", "win32")).toBe("avdmanager.bat");
  });
});
