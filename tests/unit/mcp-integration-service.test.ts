import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { McpIntegrationService } from "../../src/setup/mcp-integration-service.js";

describe("McpIntegrationService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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

  it("uses an explicit client executable outside the server PATH", async () => {
    vi.stubEnv("BROWSER_TESTBENCH_CODEX_PATH", "/opt/codex/bin/codex");
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "1.0.0", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ transport: { command: "browser-testbench", args: ["mcp"] } }),
        stderr: "",
      });

    await expect(McpIntegrationService.status("codex")).resolves.toMatchObject({
      installed: true,
      executable: "/opt/codex/bin/codex",
      executableSource: "environment",
    });
    expect(run).toHaveBeenNthCalledWith(
      1,
      "/opt/codex/bin/codex",
      ["--version"],
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("uses the resolved executable when replacing a non-portable connection", async () => {
    vi.stubEnv("BROWSER_TESTBENCH_CODEX_PATH", "/opt/codex/bin/codex");
    const portableConnection = JSON.stringify({
      transport: { command: "browser-testbench", args: ["mcp"] },
    });
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "1.0.0", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "/local/dist/cli.js browser-testbench", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "1.0.0", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: portableConnection, stderr: "" });

    await expect(McpIntegrationService.register("codex")).resolves.toMatchObject({ current: true });
    expect(run).toHaveBeenNthCalledWith(
      3,
      "/opt/codex/bin/codex",
      ["mcp", "remove", "browser-testbench"],
      expect.any(Object),
    );
    expect(run).toHaveBeenNthCalledWith(
      4,
      "/opt/codex/bin/codex",
      ["mcp", "add", "browser-testbench", "--", "browser-testbench", "mcp"],
      expect.any(Object),
    );
  });

  it("checks whether the VS Code command-line launcher is actually available", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: -1, stdout: "", stderr: "not found" });

    await expect(McpIntegrationService.status("copilot-vscode")).resolves.toMatchObject({
      installed: false,
      automatic: false,
      detail: expect.stringContaining("BROWSER_TESTBENCH_CODE_PATH"),
    });
  });

  it("reports an invalid explicit client executable separately", async () => {
    vi.stubEnv("BROWSER_TESTBENCH_GEMINI_PATH", "/missing/gemini");
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: -1, stdout: "", stderr: "not found" });

    await expect(McpIntegrationService.status("gemini-cli")).resolves.toMatchObject({
      installed: false,
      detail:
        "Gemini CLI could not be started through BROWSER_TESTBENCH_GEMINI_PATH. Check the configured executable path.",
    });
  });
});
