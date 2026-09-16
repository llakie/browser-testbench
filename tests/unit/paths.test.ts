import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { NodePackageResolver, TestbenchDataDirectory } from "../../src/infrastructure/paths.js";

describe("NodePackageResolver", () => {
  it("resolves a binary from a dependency hoisted above the installed package", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-testbench-paths-"));
    const packageDirectory = join(root, "node_modules", "appium");
    const installedModule = join(root, "node_modules", "browser-testbench", "dist", "infrastructure", "paths.js");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ bin: { appium: "index.js" } }));
    await writeFile(join(packageDirectory, "index.js"), "#!/usr/bin/env node\n");

    const resolved = NodePackageResolver.binary("appium", "appium", pathToFileURL(installedModule).href);
    expect(await realpath(resolved)).toBe(await realpath(join(packageDirectory, "index.js")));
  });
});

describe("TestbenchDataDirectory", () => {
  it.each([
    ["darwin", {}, "test-home", join("test-home", "Library", "Application Support", "browser-testbench")],
    ["linux", {}, "test-home", join("test-home", ".local", "share", "browser-testbench")],
    [
      "win32",
      { LOCALAPPDATA: join("test-home", "AppData", "Local") },
      "test-home",
      join("test-home", "AppData", "Local", "browser-testbench"),
    ],
  ] as const)("uses a stable %s data directory", (platform, environment, home, expected) => {
    expect(TestbenchDataDirectory.resolve(platform, environment, home)).toBe(expected);
  });

  it("supports an explicit data directory", () => {
    expect(
      TestbenchDataDirectory.resolve("linux", { BROWSER_TESTBENCH_DATA_DIR: "/srv/testbench" }, "/home/test"),
    ).toBe(resolve("/srv/testbench"));
  });
});
