import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigLoader } from "../../src/config/config-loader.js";

describe("ConfigLoader", () => {
  it("loads and normalizes a portable JSON config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-config-"));
    const path = join(directory, "testbench.config.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "example",
        baseUrl: "http://127.0.0.1:3000",
        targets: ["chrome", { name: "safari", enabled: false }],
        specs: ["tests/*.mjs"],
      }),
    );

    const config = await ConfigLoader.load(path);
    expect(config.targets).toEqual([{ name: "chrome" }]);
    expect(config.configDir).toBe(directory);
    expect(config.artifactsDir).toBe(join(directory, "artifacts"));
    expect(config.timeoutMs).toBe(30_000);
    expect(config.targetPolicy).toBe("strict");
  });

  it("applies per-run target, spec, policy, and headless overrides to a project config", () => {
    const config = ConfigLoader.fromOptions({
      url: "https://example.com",
      targets: ["chrome", "firefox"],
      specs: ["all.spec.mjs"],
    });
    const overridden = ConfigLoader.withRunOverrides(config, {
      targets: ["firefox"],
      specs: ["smoke.spec.mjs"],
      headless: true,
      targetPolicy: "available",
    });
    expect(overridden.targets).toEqual([{ name: "firefox", headless: true }]);
    expect(overridden.specs).toEqual(["smoke.spec.mjs"]);
    expect(overridden.targetPolicy).toBe("available");
  });

  it("rejects project process configuration because the application owns its server", () => {
    expect(() =>
      ConfigLoader.validate({
        name: "separated",
        baseUrl: "https://example.com",
        targets: ["chrome"],
        webServer: { command: "npm run dev" },
      }),
    ).toThrow("Unrecognized key");
  });

  it("rejects unknown targets", () => {
    expect(() => ConfigLoader.fromOptions({ url: "https://example.com", targets: ["netscape"] })).toThrow(
      "Unknown target",
    );
  });

  it("rejects misspelled configuration options instead of silently discarding them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-config-"));
    const path = join(directory, "testbench.config.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "typo",
        baseUrl: "https://example.com",
        targets: [{ name: "chrome", hedless: true }],
      }),
    );
    await expect(ConfigLoader.load(path)).rejects.toThrow("Unrecognized key");
  });
});
