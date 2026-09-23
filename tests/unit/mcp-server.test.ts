import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES } from "../../src/config/types.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { ApiServer } from "../../src/transports/api-server.js";

describe("MCP transport", () => {
  it("exposes the agent control surface over stdio", async () => {
    vi.spyOn(DoctorService, "inspect").mockResolvedValue(
      TARGET_NAMES.map((id) => ({
        id,
        label: TargetRegistry.definitions[id].label,
        status: TargetRegistry.isSupported(id) ? "ready" : "skip",
        detail: "Test environment",
      })),
    );
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
          "discover_testbenches",
          "get_testbench_connection",
          "connect_testbench",
          "disconnect_testbench",
        ]),
      );
      expect(tools.tools.find((tool) => tool.name === "connect_testbench")?.annotations).toMatchObject({
        readOnlyHint: false,
      });
      expect(tools.tools.find((tool) => tool.name === "disconnect_testbench")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(tools.tools.find((tool) => tool.name === "take_screenshot")?.annotations).toMatchObject({
        readOnlyHint: false,
      });
      expect(tools.tools.find((tool) => tool.name === "wait_condition")?.annotations).toMatchObject({
        readOnlyHint: false,
      });
      expect(tools.tools.find((tool) => tool.name === "close_session")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      const result = await client.callTool({ name: "list_targets", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("chrome");
    } finally {
      await client.close();
      await api.stop();
      vi.restoreAllMocks();
    }
  }, 15_000);
});
