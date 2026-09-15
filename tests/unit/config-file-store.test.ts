import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigFileStore } from "../../src/config/config-file-store.js";

describe("ConfigFileStore", () => {
  it("provides a useful draft and atomically persists valid JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-config-"));
    const path = join(directory, "testbench.config.json");
    const store = new ConfigFileStore(path);

    const draft = await store.read();
    expect(draft.exists).toBe(false);
    expect(draft.config.baseUrl).toBe("http://127.0.0.1:3000");

    await store.save({ ...draft.config, name: "portable-suite", targets: ["chrome"] });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toMatchObject({ name: "portable-suite", targets: ["chrome"] });
    expect((await store.read()).exists).toBe(true);
  });

  it("rejects unsupported config fields before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-config-"));
    const store = new ConfigFileStore(join(directory, "testbench.config.json"));
    await expect(
      store.save({ name: "invalid", baseUrl: "https://example.com", targets: ["chrome"], typo: true }),
    ).rejects.toThrow();
  });
});
