import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP transport", () => {
  it("exposes the agent control surface over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp"],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "browser-testbench-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "doctor",
          "start_session",
          "inspect_page",
          "take_screenshot",
          "tap",
          "swipe",
          "pinch",
          "wait_for_element",
          "wait_for_text",
          "wait_for_url",
          "get_diagnostics",
          "get_devtools_instructions",
        ]),
      );
      const result = await client.callTool({ name: "list_targets", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("chrome-android");
    } finally {
      await client.close();
    }
  });
});
