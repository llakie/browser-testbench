import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { TestbenchPaths } from "../../src/infrastructure/paths.js";
import { McpIntegrationService } from "../../src/setup/mcp-integration-service.js";

describe("McpIntegrationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("provides client-specific setup commands", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: -1, stdout: "", stderr: "not found" });

    expect((await McpIntegrationService.status("codex")).command).toContain("codex mcp add browser-testbench");
    expect((await McpIntegrationService.status("claude-code")).command).toContain(
      "claude mcp add --transport stdio --scope user browser-testbench",
    );
    expect((await McpIntegrationService.status("gemini-cli")).command).toContain(
      "gemini mcp add --scope user browser-testbench",
    );
    expect((await McpIntegrationService.status("copilot-vscode")).command).toContain("code --add-mcp");
  });

  it("provides a portable configuration for other MCP clients", async () => {
    const status = await McpIntegrationService.status("other");
    const config = JSON.parse(status.command);

    expect(status.format).toBe("json");
    expect(config.mcpServers["browser-testbench"]).toMatchObject({
      command: "node",
      args: [expect.stringContaining("dist/cli.js"), "mcp"],
    });
  });

  it("recognizes a current Claude Code connection", async () => {
    vi.spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "2.1.0", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: `browser-testbench: node ${TestbenchPaths.projectRoot}/dist/cli.js mcp`,
        stderr: "",
      });

    await expect(McpIntegrationService.status("claude-code")).resolves.toMatchObject({
      installed: true,
      automatic: true,
      current: true,
    });
  });
});
