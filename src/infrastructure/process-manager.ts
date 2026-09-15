import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { CommandRunner } from "./command-runner.js";
import { TestbenchPaths } from "./paths.js";
import type { WebServerConfig } from "../config/types.js";

export class ManagedProcess {
  readonly child: ChildProcess;
  private output = "";

  constructor(command: string, cwd?: string, env?: Record<string, string>) {
    this.child = CommandRunner.spawnShell(command, { cwd, env: { ...process.env, ...env } });
    this.child.stdout?.on("data", (chunk) => (this.output += String(chunk)));
    this.child.stderr?.on("data", (chunk) => (this.output += String(chunk)));
  }

  get recentOutput(): string {
    return this.output.slice(-8_000);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    if (process.platform === "win32") {
      await CommandRunner.run("taskkill", ["/PID", String(this.child.pid), "/T"], { timeoutMs: 5_000 });
    } else if (this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    }
    await Promise.race([once(this.child, "close"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (this.child.exitCode === null) {
      if (process.platform !== "win32" && this.child.pid) {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      } else {
        await CommandRunner.run("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { timeoutMs: 5_000 });
      }
    }
  }
}

export class ServiceManager {
  static async startWebServer(config: WebServerConfig): Promise<ManagedProcess> {
    const process = new ManagedProcess(config.command, config.cwd, config.env);
    if (config.healthUrl) {
      try {
        await this.waitForUrl(config.healthUrl, config.timeoutMs ?? 60_000, process);
      } catch (error) {
        await process.stop();
        throw error;
      }
    }
    return process;
  }

  static async startAppium(): Promise<{ process: ManagedProcess; port: number }> {
    const port = await this.freePort();
    const appiumHome = TestbenchPaths.cache("appium");
    await mkdir(appiumHome, { recursive: true });
    await mkdir(TestbenchPaths.cache("chromedrivers"), { recursive: true });
    const executable = TestbenchPaths.localBinary("appium");
    const process = new ManagedProcess(
      `\"${executable}\" --address 127.0.0.1 --port ${port} --log-level warn --allow-insecure uiautomator2:chromedriver_autodownload`,
      TestbenchPaths.projectRoot,
      { APPIUM_HOME: appiumHome },
    );
    try {
      await this.waitForUrl(`http://127.0.0.1:${port}/status`, 30_000, process);
      return { process, port };
    } catch (error) {
      await process.stop();
      throw error;
    }
  }

  static async waitForUrl(url: string, timeoutMs: number, managedProcess?: ManagedProcess): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (managedProcess && managedProcess.child.exitCode !== null) {
        throw new Error(`Process exited before ${url} became ready.\n${managedProcess.recentOutput}`);
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
      } catch {
        // Service is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}.\n${managedProcess?.recentOutput ?? ""}`);
  }

  private static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Could not allocate a local port."));
          return;
        }
        const port = address.port;
        server.close(() => resolve(port));
      });
    });
  }
}
