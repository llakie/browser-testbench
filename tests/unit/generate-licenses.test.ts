import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThirdPartyLicenseGenerator } from "../../scripts/generate-licenses.mjs";

describe("ThirdPartyLicenseGenerator", () => {
  it("resolves configured license replacements relative to the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-licenses-"));
    const configPath = join(directory, ".glf.json");
    await writeFile(configPath, JSON.stringify({ replace: { "dual-license": "licenses/MIT.txt" } }));

    await expect(ThirdPartyLicenseGenerator.readReplacements(configPath)).resolves.toEqual({
      "dual-license": join(directory, "licenses", "MIT.txt"),
    });
  });

  it("includes every platform package and its dependency closure from the lockfile", () => {
    const lockfile = {
      packages: {
        "": { dependencies: { portable: "1.0.0" } },
        "node_modules/portable": { version: "1.0.0", license: "MIT" },
        "node_modules/native-darwin": {
          version: "1.0.0",
          license: "ISC",
          os: ["darwin"],
          dependencies: { runtime: "1.0.0" },
        },
        "node_modules/native-win32": {
          version: "1.0.0",
          license: "ISC",
          os: ["win32"],
          dependencies: { runtime: "1.0.0" },
        },
        "node_modules/runtime": { version: "1.0.0", license: "MIT" },
        "node_modules/dev-native": { version: "1.0.0", license: "MIT", os: ["linux"], dev: true },
      },
    };

    expect(ThirdPartyLicenseGenerator.findPlatformPackages(lockfile)).toEqual([
      { identifier: "native-darwin@1.0.0", license: "ISC" },
      { identifier: "native-win32@1.0.0", license: "ISC" },
      { identifier: "runtime@1.0.0", license: "MIT" },
    ]);
  });

  it("formats platform packages in stable license and package order", () => {
    const output = ThirdPartyLicenseGenerator.formatPlatformSections([
      { identifier: "native-z@1.0.0", license: "MIT" },
      { identifier: "native-a@1.0.0", license: "MIT" },
      { identifier: "native-b@1.0.0", license: "Apache-2.0" },
    ]);

    expect(output.indexOf("Apache-2.0")).toBeLessThan(output.indexOf("MIT"));
    expect(output.indexOf("native-a@1.0.0")).toBeLessThan(output.indexOf("native-z@1.0.0"));
  });
});
