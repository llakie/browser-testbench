import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaTooling } from "../../src/infrastructure/media-tooling.js";

describe("MediaTooling", () => {
  it("reports each executable that is missing from PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-media-tooling-"));
    const ffmpeg = join(directory, "ffmpeg");
    await writeFile(ffmpeg, "");
    await chmod(ffmpeg, 0o755);

    expect(MediaTooling.missing({ PATH: directory }, "linux")).toEqual(["ffprobe"]);
    expect(MediaTooling.missing({ PATH: [directory, "/missing"].join(delimiter) }, "linux")).toEqual(["ffprobe"]);
  });

  it.each([
    ["darwin", "brew", "brew install ffmpeg"],
    ["win32", "winget.exe", "winget install --id Gyan.FFmpeg --exact"],
    ["linux", "apt-get", "sudo apt-get install ffmpeg"],
    ["linux", "dnf", "sudo dnf install ffmpeg"],
  ] as const)("provides the guided %s installation command", async (platform, executable, command) => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-package-manager-"));
    const binary = join(directory, executable);
    await writeFile(binary, "");
    await chmod(binary, 0o755);

    expect(MediaTooling.installationCommand({ PATH: directory }, platform)).toBe(command);
  });

  it("leaves the command empty when no supported package manager is available", () => {
    expect(MediaTooling.installationCommand({ PATH: "" }, "linux")).toBeUndefined();
  });
});
