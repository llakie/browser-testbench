import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { TestbenchDefaults } from "../config/defaults.js";
import { AndroidSdk } from "./android-sdk.js";
import { CommandRunner } from "./command-runner.js";
import { TestbenchPaths } from "./paths.js";

const PROCESS_STOP_TIMEOUT_MS = 5_000;
const APPIUM_START_TIMEOUT_MS = 30_000;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const RECENT_OUTPUT_MAX_LENGTH = 8_000;

export class ManagedProcess {
  readonly child: ChildProcess;
  private output = "";

  constructor(command: string, cwd?: string, env?: Record<string, string>) {
    this.child = CommandRunner.spawnShell(command, { cwd, env: { ...process.env, ...env } });
    this.child.stdout?.on("data", (chunk) => (this.output += String(chunk)));
    this.child.stderr?.on("data", (chunk) => (this.output += String(chunk)));
  }

  get recentOutput(): string {
    return this.output.slice(-RECENT_OUTPUT_MAX_LENGTH);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    if (process.platform === "win32") {
      await CommandRunner.run("taskkill", ["/PID", String(this.child.pid), "/T"], {
        timeoutMs: PROCESS_STOP_TIMEOUT_MS,
      });
    } else if (this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    }
    await Promise.race([
      once(this.child, "close"),
      new Promise((resolve) => setTimeout(resolve, PROCESS_STOP_TIMEOUT_MS)),
    ]);
    if (this.child.exitCode === null) {
      if (process.platform !== "win32" && this.child.pid) {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      } else {
        await CommandRunner.run("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], {
          timeoutMs: PROCESS_STOP_TIMEOUT_MS,
        });
      }
    }
  }
}

export class ServiceManager {
  static async startAppium(): Promise<{ process: ManagedProcess; port: number }> {
    const port = await this.freePort();
    const appiumHome = TestbenchPaths.data("appium");
    await mkdir(appiumHome, { recursive: true });
    await mkdir(TestbenchPaths.data("chromedrivers"), { recursive: true });
    const executable = TestbenchPaths.packageBinary("appium");
    const androidSdkRoot = await AndroidSdk.root();
    const managedProcess = new ManagedProcess(
      TestbenchPaths.shellCommand([
        process.execPath,
        executable,
        "--address",
        TestbenchDefaults.LOOPBACK_HOST,
        "--port",
        String(port),
        "--log-level",
        "warn",
        "--allow-insecure",
        "uiautomator2:chromedriver_autodownload",
      ]),
      TestbenchPaths.projectRoot,
      {
        APPIUM_HOME: appiumHome,
        ...(androidSdkRoot ? AndroidSdk.environment(androidSdkRoot) : {}),
      },
    );
    try {
      await this.waitForUrl(
        `http://${TestbenchDefaults.LOOPBACK_HOST}:${port}/status`,
        APPIUM_START_TIMEOUT_MS,
        managedProcess,
      );
      return { process: managedProcess, port };
    } catch (error) {
      await managedProcess.stop();
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
        const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
        if (response.ok) return;
      } catch {
        // Service is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}.\n${managedProcess?.recentOutput ?? ""}`);
  }

  private static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, TestbenchDefaults.LOOPBACK_HOST, () => {
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
