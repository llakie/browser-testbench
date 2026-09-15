import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactManager } from "../../src/artifacts/artifact-manager.js";
import type { RunSummary } from "../../src/config/types.js";

describe("ArtifactManager", () => {
  it("renders the HTML report from the Eta template and escapes report data", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-testbench-artifacts-"));
    const manager = new ArtifactManager(root, "run-1");
    const summary: RunSummary = {
      id: "run-1",
      name: "A <script>alert(1)</script>",
      status: "failed",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      baseUrl: "https://example.com",
      artifactDir: manager.runDir,
      targets: [
        {
          target: "chrome",
          status: "failed",
          durationMs: 42,
          tests: [
            {
              name: "unsafe <name>",
              target: "chrome",
              status: "failed",
              durationMs: 42,
              error: "Expected <actual>",
              artifacts: [],
            },
          ],
        },
      ],
    };

    await manager.initialize();
    await manager.writeSummary(summary);

    const report = await readFile(join(manager.runDir, "report.html"), "utf8");
    expect(report).toContain("<!doctype html>");
    expect(report).toContain("A &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report).toContain("unsafe &lt;name&gt;");
    expect(report).not.toContain("<script>alert(1)</script>");
  });
});
