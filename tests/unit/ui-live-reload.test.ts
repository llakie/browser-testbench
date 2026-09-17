import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UiLiveReload } from "../../src/ui/ui-live-reload.js";

describe("UiLiveReload", () => {
  const temporaryDirectories: string[] = [];
  const reloaders: UiLiveReload[] = [];

  afterEach(async () => {
    for (const reloader of reloaders.splice(0)) reloader.stop();
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("notifies subscribers when a UI file changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-live-reload-"));
    temporaryDirectories.push(directory);
    const reloader = new UiLiveReload([directory]);
    reloaders.push(reloader);
    reloader.start();

    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UI change was not detected.")), 2_000);
      reloader.subscribe(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await writeFile(join(directory, "setup.css"), "body {}", "utf8");

    await expect(changed).resolves.toBeUndefined();
  });
});
