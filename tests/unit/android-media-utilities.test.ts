import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AndroidMediaUtilities } from "../../src/automation/android-media-utilities.js";

describe("AndroidMediaUtilities", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-camera-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("maps a PNG asset to internal emulator arguments and reports dimensions", async () => {
    const path = join(directory, "camera.png");
    const png = Buffer.alloc(24);
    png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 0);
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(1920, 20);
    await writeFile(path, png);
    const reference = {
      id: "00000000-0000-4000-8000-000000000000",
      name: "camera.png",
      contentType: "image/png",
      size: png.length,
      sha256: "0".repeat(64),
    };

    const result = await AndroidMediaUtilities.prepare(
      {
        id: "android",
        browser: "chrome-android",
        label: "Android",
        kind: "mobile",
        status: "ready",
        ready: true,
        serial: true,
        deviceKind: "emulator",
        detail: "ready",
        config: { name: "chrome-android" },
      },
      { path, reference },
    );

    expect(result.capabilities["appium:avdArgs"]).toEqual(["-camera-back", `imagefile:${path}`]);
    expect(result.metadata).toMatchObject({ width: 1080, height: 1920, orientation: "portrait" });
  });

  it("rejects physical devices before browser startup", async () => {
    await expect(
      AndroidMediaUtilities.prepare(
        {
          id: "physical",
          browser: "chrome-android",
          label: "Android",
          kind: "mobile",
          status: "ready",
          ready: true,
          serial: true,
          deviceKind: "physical",
          detail: "ready",
          config: { name: "chrome-android" },
        },
        {
          path: "unused.jpg",
          reference: {
            id: "00000000-0000-4000-8000-000000000000",
            name: "camera.jpg",
            contentType: "image/jpeg",
            size: 1,
            sha256: "0".repeat(64),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MEDIA_INJECTION_UNSUPPORTED" });
  });
});
