import { describe, expect, it } from "vitest";
import { OutputFormatter } from "../../src/cli/output-formatter.js";

describe("OutputFormatter", () => {
  it("renders setup message descriptors in English for the CLI", () => {
    const output = OutputFormatter.setup([
      {
        id: "android-system-image",
        label: { key: "environment.avdImageLabel" },
        automatic: false,
        status: "manual",
        detail: {
          key: "environment.avdImageMissing",
          parameters: { architecture: "arm64-v8a" },
        },
      },
    ]);

    expect(output).toContain("Google Play system image");
    expect(output).toContain("No compatible Google Play system image for arm64-v8a is installed.");
  });
});
