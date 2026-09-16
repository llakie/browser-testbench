import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PackageMetadata } from "../config/package-metadata.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

const LAUNCHER_SOURCE = `import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";

const [nodeExecutable, npxCli, ...args] = process.argv.slice(2);
const environment = { ...process.env };
const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
environment[pathKey] = [dirname(nodeExecutable), environment[pathKey]].filter(Boolean).join(delimiter);

const child = spawn(nodeExecutable, [npxCli, ...args], { env: environment, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;

interface LauncherContext {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  dataDirectory?: string;
}

export interface McpServerLaunchCommand {
  command: string;
  args: string[];
  verificationArgs: string[];
}

export class McpServerLauncher {
  private static readonly preparations = new Map<string, Promise<void>>();

  static async prepare(context: LauncherContext = {}): Promise<void> {
    const launcherPath = this.launcherPath(context);
    const existing = this.preparations.get(launcherPath);
    if (existing) return existing;

    const preparation = this.writeLauncher(launcherPath).catch((error) => {
      this.preparations.delete(launcherPath);
      throw error;
    });
    this.preparations.set(launcherPath, preparation);
    return preparation;
  }

  static command(context: LauncherContext = {}): McpServerLaunchCommand {
    const platform = context.platform ?? process.platform;
    const environment = context.environment ?? process.env;
    const nodeExecutable = context.nodeExecutable ?? process.execPath;
    const packageSpec = `${PackageMetadata.NAME}@latest`;
    const npxCli = this.npxCli(platform, environment, nodeExecutable);

    if (!npxCli) {
      return {
        command: "npx",
        args: ["--yes", packageSpec, "mcp"],
        verificationArgs: ["--yes", packageSpec, "--version"],
      };
    }

    return {
      command: nodeExecutable,
      args: [this.launcherPath(context), nodeExecutable, npxCli, "--yes", packageSpec, "mcp"],
      verificationArgs: [this.launcherPath(context), nodeExecutable, npxCli, "--yes", packageSpec, "--version"],
    };
  }

  private static launcherPath(context: LauncherContext): string {
    return join(context.dataDirectory ?? TestbenchPaths.dataRoot, "mcp", "launcher.mjs");
  }

  private static async writeLauncher(launcherPath: string): Promise<void> {
    await mkdir(dirname(launcherPath), { recursive: true });
    const current = await readFile(launcherPath, "utf8").catch(() => undefined);
    if (current !== LAUNCHER_SOURCE) await writeFile(launcherPath, LAUNCHER_SOURCE, { mode: 0o600 });
  }

  private static npxCli(
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    nodeExecutable: string,
  ): string | undefined {
    const override = environment.BROWSER_TESTBENCH_NPX_CLI_PATH?.trim();
    const nodeDirectory = dirname(nodeExecutable);
    const candidates = [
      override,
      platform === "win32"
        ? join(nodeDirectory, "node_modules", "npm", "bin", "npx-cli.js")
        : resolve(nodeDirectory, "../lib/node_modules/npm/bin/npx-cli.js"),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (existsSync(candidate)) return realpathSync(candidate);
    }
    return undefined;
  }
}
