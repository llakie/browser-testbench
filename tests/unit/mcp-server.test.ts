import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { ApiServer } from "../../src/transports/api-server.js";

describe("MCP transport", () => {
  it("exposes the agent control surface over stdio", async () => {
    const api = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await api.start();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp", "--server", `http://${address.host}:${address.port}`],
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
          "verify_target",
          "start_session",
          "inspect_page",
          "take_screenshot",
          "tap",
          "swipe",
          "pinch",
          "element_action",
          "browser_action",
          "wait_for_element",
          "wait_condition",
          "wait_for_text",
          "wait_for_url",
          "wait_for_state",
          "wait_for_value",
          "wait_for_count",
          "get_diagnostics",
          "clear_diagnostics",
          "get_devtools_instructions",
        ]),
      );
      const result = await client.callTool({ name: "list_targets", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("chrome");
    } finally {
      await client.close();
      await api.stop();
    }
  });
});
