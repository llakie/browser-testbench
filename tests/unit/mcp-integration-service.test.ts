import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { McpIntegrationService } from "../../src/setup/mcp-integration-service.js";

describe("McpIntegrationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("provides client-specific setup commands", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: -1, stdout: "", stderr: "not found" });

    expect((await McpIntegrationService.status("codex")).command).toBe(
      "codex mcp add browser-testbench -- browser-testbench mcp",
    );
    expect((await McpIntegrationService.status("claude-code")).command).toContain(
      "claude mcp add --transport stdio --scope user browser-testbench",
    );
    expect((await McpIntegrationService.status("gemini-cli")).command).toContain(
      "gemini mcp add --scope user browser-testbench",
    );
    expect((await McpIntegrationService.status("copilot-vscode")).command).toContain("code --add-mcp");
    expect((await McpIntegrationService.status("codex")).command).not.toContain("dist/cli.js");
  });

  it("provides a portable configuration for other MCP clients", async () => {
    const status = await McpIntegrationService.status("other");
    const config = JSON.parse(status.command);

    expect(status.format).toBe("json");
    expect(config.mcpServers["browser-testbench"]).toMatchObject({
      command: "browser-testbench",
      args: ["mcp"],
    });
  });

  it("recognizes a current Claude Code connection", async () => {
    vi.spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "2.1.0", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "browser-testbench: browser-testbench mcp",
        stderr: "",
      });

    await expect(McpIntegrationService.status("claude-code")).resolves.toMatchObject({
      installed: true,
      automatic: true,
      current: true,
    });
  });

  it("recognizes a portable Codex JSON connection", async () => {
    vi.spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "1.0.0", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ transport: { command: "browser-testbench", args: ["mcp"] } }),
        stderr: "",
      });

    await expect(McpIntegrationService.status("codex")).resolves.toMatchObject({ current: true });
  });
});
