import { type ChildProcess, spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandRunner {
  static run(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;

      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      if (options.input !== undefined) child.stdin?.end(options.input);
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  static spawnShell(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
    return spawn(command, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}
