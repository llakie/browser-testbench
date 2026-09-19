import { spawn, type ChildProcess } from "node:child_process";

const FORCE_STOP_TIMEOUT_MS = 2_000;

export class ProcessTerminator {
  static async stop(
    child: ChildProcess,
    options: { gracefulSignal?: NodeJS.Signals; graceMs: number; group?: boolean },
  ): Promise<void> {
    if (this.closed(child)) return;
    await this.signal(child, options.gracefulSignal ?? "SIGTERM", Boolean(options.group), false);
    if (await this.wait(child, options.graceMs)) return;
    await this.signal(child, "SIGKILL", Boolean(options.group), true);
    if (!(await this.wait(child, FORCE_STOP_TIMEOUT_MS))) {
      throw new Error(`Process ${child.pid ?? "unknown"} did not stop after forced termination.`);
    }
  }

  static wait(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.closed(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const complete = (closed: boolean): void => {
        clearTimeout(timer);
        child.off("close", onClose);
        resolve(closed || this.closed(child));
      };
      const onClose = (): void => complete(true);
      const timer = setTimeout(() => complete(false), timeoutMs);
      timer.unref();
      child.once("close", onClose);
    });
  }

  private static async signal(
    child: ChildProcess,
    signal: NodeJS.Signals,
    group: boolean,
    force: boolean,
  ): Promise<void> {
    if (this.closed(child)) return;
    if (process.platform === "win32" && group && child.pid) {
      await this.taskkill(child.pid, force);
      return;
    }
    try {
      if (group && child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private static async taskkill(pid: number, force: boolean): Promise<void> {
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!(await this.wait(taskkill, FORCE_STOP_TIMEOUT_MS)) && !this.closed(taskkill)) taskkill.kill("SIGKILL");
  }

  private static closed(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }
}
