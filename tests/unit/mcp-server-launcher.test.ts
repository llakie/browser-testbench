import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { McpServerLauncher } from "../../src/setup/mcp-server-launcher.js";

describe("McpServerLauncher", () => {
  it("uses the current Node runtime and its npx CLI without relying on PATH", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "browser-testbench-node-runtime-"));
    const nodeExecutable = join(runtime, "bin", "node");
    const npxCli = resolve(runtime, "lib/node_modules/npm/bin/npx-cli.js");
    const launcher = join(runtime, "data", "mcp", "launcher.mjs");
    await mkdir(join(runtime, "bin"), { recursive: true });
    await mkdir(join(npxCli, ".."), { recursive: true });
    await writeFile(nodeExecutable, "");
    await writeFile(npxCli, "");

    expect(
      McpServerLauncher.command({
        platform: "darwin",
        environment: { PATH: "" },
        nodeExecutable,
        dataDirectory: join(runtime, "data"),
      }),
    ).toEqual({
      command: nodeExecutable,
      args: [launcher, nodeExecutable, realpathSync(npxCli), "--yes", "browser-testbench@latest", "mcp"],
      verificationArgs: [
        launcher,
        nodeExecutable,
        realpathSync(npxCli),
        "--yes",
        "browser-testbench@latest",
        "--version",
      ],
    });
  });

  it("supports the npm layout installed with Node on Windows", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "browser-testbench-windows-node-runtime-"));
    const nodeExecutable = join(runtime, "node.exe");
    const npxCli = join(runtime, "node_modules", "npm", "bin", "npx-cli.js");
    const launcher = join(runtime, "data", "mcp", "launcher.mjs");
    await mkdir(join(npxCli, ".."), { recursive: true });
    await writeFile(nodeExecutable, "");
    await writeFile(npxCli, "");

    expect(
      McpServerLauncher.command({
        platform: "win32",
        environment: { PATH: "" },
        nodeExecutable,
        dataDirectory: join(runtime, "data"),
      }),
    ).toMatchObject({
      command: nodeExecutable,
      args: [launcher, nodeExecutable, realpathSync(npxCli), "--yes", "browser-testbench@latest", "mcp"],
    });
  });

  it("writes a persistent launcher outside the project", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "browser-testbench-launcher-data-"));
    await McpServerLauncher.prepare({ dataDirectory });

    const source = await readFile(join(dataDirectory, "mcp", "launcher.mjs"), "utf8");
    expect(source).toContain('stdio: "inherit"');
    expect(source).toContain("dirname(nodeExecutable)");
  });
});
