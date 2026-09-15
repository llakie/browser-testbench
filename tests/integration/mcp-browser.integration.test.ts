import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { FixtureServer } from "../../src/support/fixture-server.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;

describe("MCP browser control", () => {
  browserTest(
    "drives Chrome, inspects state, and captures a screenshot",
    async () => {
      const fixture = new FixtureServer();
      const url = await fixture.start();
      const outputDirectory = await mkdtemp(join(tmpdir(), "browser-testbench-mcp-"));
      const screenshotPath = join(outputDirectory, "mcp.png");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "mcp"],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      const client = new Client({ name: "browser-testbench-integration", version: "1.0.0" });

      try {
        await client.connect(transport);
        await client.callTool({ name: "start_session", arguments: { target: "chrome", url, headless: true } });
        await client.callTool({ name: "type", arguments: { selector: "#name", value: "MCP" } });
        await client.callTool({ name: "click", arguments: { selector: "#submit" } });
        const inspection = await client.callTool({ name: "inspect_page", arguments: { limit: 20 } });
        expect(JSON.stringify(inspection.content)).toContain("Browser Testbench Fixture");
        const source = await client.callTool({ name: "get_page_source", arguments: { maxCharacters: 10_000 } });
        expect(JSON.stringify(source.content)).toContain("Hello MCP");
        const screenshot = await client.callTool({ name: "take_screenshot", arguments: { path: screenshotPath } });
        expect(JSON.stringify(screenshot.content)).toContain(screenshotPath);
        await client.callTool({ name: "close_session", arguments: {} });
      } finally {
        await client.close();
        await fixture.stop();
      }
    },
    30_000,
  );
});
