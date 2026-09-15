import { describe, expect, it } from "vitest";
import { ConfigLoader } from "../../src/config/config-loader.js";

describe("ConfigLoader", () => {
  it("normalizes built-in verification options", () => {
    const config = ConfigLoader.fromOptions({ url: "http://127.0.0.1:3000", targets: ["chrome"] });
    expect(config.targets).toEqual([{ name: "chrome", headless: undefined }]);
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

  it("rejects misspelled internal verification options instead of silently discarding them", () => {
    expect(() =>
      ConfigLoader.validate({
        name: "typo",
        baseUrl: "https://example.com",
        targets: [{ name: "chrome", hedless: true }],
      }),
    ).toThrow("Unrecognized key");
  });
});
