import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpClientExecutableResolver } from "../../src/setup/mcp-client-executable-resolver.js";

describe("McpClientExecutableResolver", () => {
  it("includes the standalone per-user installation for every CLI client", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-testbench-client-home-"));
    const executable = join(home, ".local", "bin", "gemini");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(executable, "");

    const candidates = McpClientExecutableResolver.candidates(
      {
        id: "gemini-cli",
        binary: "gemini",
        environmentVariable: "BROWSER_TESTBENCH_GEMINI_PATH",
      },
      { platform: "darwin", environment: { PATH: "" }, home },
    );

    expect(candidates).toContainEqual({ command: executable, source: "user" });
  });

  it("finds Codex bundled with the installed VS Code extension as a fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-testbench-codex-home-"));
    const executable = join(
      home,
      ".vscode",
      "extensions",
      "openai.chatgpt-1.2.3-darwin-arm64",
      "bin",
      "darwin-arm64",
      "codex",
    );
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "");

    const candidates = McpClientExecutableResolver.candidates(
      {
        id: "codex",
        binary: "codex",
        environmentVariable: "BROWSER_TESTBENCH_CODEX_PATH",
      },
      { platform: "darwin", environment: { PATH: "" }, home },
    );

    expect(candidates).toContainEqual({ command: executable, source: "ide" });
  });

  it("prefers Windows command wrappers over ambiguous bare executable names", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-testbench-vscode-home-"));
    const installDirectory = join(home, "AppData", "Local", "Programs", "Microsoft VS Code");
    const binDirectory = join(installDirectory, "bin");
    const commandWrapper = join(binDirectory, "code.cmd");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(join(installDirectory, "Code.exe"), "");
    await writeFile(commandWrapper, "");

    try {
      const candidates = McpClientExecutableResolver.candidates(
        {
          id: "copilot-vscode",
          binary: "code",
          environmentVariable: "BROWSER_TESTBENCH_CODE_PATH",
        },
        {
          platform: "win32",
          environment: {
            PATH: [installDirectory, binDirectory].join(delimiter),
            LOCALAPPDATA: join(home, "AppData", "Local"),
          },
          home,
        },
      );

      expect(candidates[0]).toEqual({ command: commandWrapper, source: "path" });
      expect(candidates.findIndex((candidate) => candidate.command === commandWrapper)).toBeLessThan(
        candidates.findIndex((candidate) => candidate.command === "code"),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
