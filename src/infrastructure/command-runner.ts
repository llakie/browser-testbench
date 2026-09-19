import { type ChildProcess, spawn } from "node:child_process";
import { extname } from "node:path";
import { ProcessTerminator } from "./process-terminator.js";

const COMMAND_STOP_GRACE_MS = 1_000;
const COMMAND_OUTPUT_MAX_LENGTH = 1024 * 1024;

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
      let child: ChildProcess;
      try {
        const requiresWindowsShell = this.requiresWindowsShell(command);
        child = spawn(
          requiresWindowsShell ? this.windowsShellCommand(command, args) : command,
          requiresWindowsShell ? [] : args,
          {
            cwd: options.cwd,
            env: options.env ?? process.env,
            shell: requiresWindowsShell,
            detached: process.platform !== "win32",
            stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch (error) {
        resolve({ code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            void ProcessTerminator.stop(child, { graceMs: COMMAND_STOP_GRACE_MS, group: true })
              .catch((error) => {
                stderr = this.appendOutput(stderr, error instanceof Error ? error.message : String(error));
              })
              .finally(() =>
                finish({
                  code: -1,
                  stdout,
                  stderr: this.appendOutput(stderr, `Command timed out after ${options.timeoutMs} ms.`),
                }),
              );
          }, options.timeoutMs)
        : undefined;

      child.stdout?.on("data", (chunk) => (stdout = this.appendOutput(stdout, String(chunk))));
      child.stderr?.on("data", (chunk) => (stderr = this.appendOutput(stderr, String(chunk))));
      if (options.input !== undefined) child.stdin?.end(options.input);
      child.on("error", (error) => {
        finish({ code: -1, stdout, stderr: this.appendOutput(stderr, error.message) });
      });
      child.on("close", (code) => {
        finish({
          code: timedOut ? -1 : (code ?? -1),
          stdout,
          stderr: timedOut ? this.appendOutput(stderr, `Command timed out after ${options.timeoutMs} ms.`) : stderr,
        });
      });
    });
  }

  private static requiresWindowsShell(command: string): boolean {
    if (process.platform !== "win32") return false;
    const extension = extname(command).toLowerCase();
    return extension === ".cmd" || extension === ".bat";
  }

  private static windowsShellCommand(command: string, args: string[]): string {
    return [command, ...args].map((value) => `"${value.replaceAll('"', '""')}"`).join(" ");
  }

  private static appendOutput(current: string, value: string): string {
    return `${current}${value}`.slice(-COMMAND_OUTPUT_MAX_LENGTH);
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
