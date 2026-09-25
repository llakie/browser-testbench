import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestbenchDefaults } from "../config/defaults.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

interface LockWaiter {
  ownerId: string;
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

interface LockMetadata {
  targetId: string;
  ownerId: string;
  sessionId: string;
  pid: number;
  processStartedAt: string;
}

export class TargetLockTimeoutError extends TestbenchError {
  constructor(targetId: string, timeoutMs: number, details: Record<string, unknown> = {}) {
    const message =
      details.reason === "owner disconnected"
        ? `The client disconnected while waiting for target '${targetId}'.`
        : `Target '${targetId}' remained busy for ${timeoutMs} ms.`;
    super("TARGET_BUSY", message, {
      operation: "target.lock",
      status: 409,
      details: { target: targetId, timeoutMs, ...details },
    });
  }
}

export class PersistentTargetLock {
  private static readonly PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

  constructor(private readonly root = TestbenchPaths.data("locks")) {}

  async cleanup(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.removeIfStale(join(this.root, entry.name))),
    );
  }

  async acquire(targetId: string, ownerId: string, sessionId: string, timeoutMs: number): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.path(targetId);
    const startedAt = performance.now();
    for (;;) {
      try {
        await mkdir(path);
        await writeFile(
          this.metadataPath(path),
          `${JSON.stringify({
            targetId,
            ownerId,
            sessionId,
            pid: process.pid,
            processStartedAt: PersistentTargetLock.PROCESS_STARTED_AT,
          } satisfies LockMetadata)}\n`,
          { flag: "wx" },
        );
        return;
      } catch (error) {
        if (!PersistentTargetLock.isExistsError(error)) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }
      if (await this.removeIfStale(path)) continue;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        const holder = await this.read(path);
        throw new TargetLockTimeoutError(targetId, timeoutMs, holder ? { holder } : {});
      }
      await delay(Math.min(TestbenchDefaults.TARGET_LOCK_POLL_INTERVAL_MS, timeoutMs - elapsedMs));
    }
  }

  async handoff(targetId: string, ownerId: string, sessionId: string): Promise<void> {
    const path = this.path(targetId);
    await writeFile(
      this.metadataPath(path),
      `${JSON.stringify({
        targetId,
        ownerId,
        sessionId,
        pid: process.pid,
        processStartedAt: PersistentTargetLock.PROCESS_STARTED_AT,
      } satisfies LockMetadata)}\n`,
    );
  }

  async release(targetId: string, sessionId: string): Promise<void> {
    const path = this.path(targetId);
    const metadata = await this.read(path);
    if (!metadata || metadata.sessionId !== sessionId || metadata.pid !== process.pid) return;
    await rm(path, { recursive: true, force: true });
  }

  private async removeIfStale(path: string): Promise<boolean> {
    const metadata = await this.read(path);
    if (!metadata) {
      const information = await stat(path).catch(() => undefined);
      if (!information || Date.now() - information.mtimeMs < 5_000) return false;
    } else if (PersistentTargetLock.processExists(metadata.pid)) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  }

  private async read(path: string): Promise<LockMetadata | undefined> {
    try {
      return JSON.parse(await readFile(this.metadataPath(path), "utf8")) as LockMetadata;
    } catch {
      return undefined;
    }
  }

  private path(targetId: string): string {
    const readable = targetId.replaceAll(/[^a-z0-9.-]/giu, "-").slice(0, 40) || "target";
    const digest = createHash("sha256").update(targetId).digest("hex").slice(0, 12);
    return join(this.root, `${readable}-${digest}.lock`);
  }

  private metadataPath(path: string): string {
    return join(path, "owner.json");
  }

  private static processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
    }
  }

  private static isExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
  }
}

export class TargetLockManager {
  private readonly queues = new Map<string, LockWaiter[]>();
  private readonly ready: Promise<void>;

  constructor(private readonly persistent = new PersistentTargetLock()) {
    this.ready = persistent.cleanup();
  }

  async acquire(
    targetId: string,
    timeoutMs: number,
    ownerId = "local",
    sessionId = ownerId,
  ): Promise<() => Promise<void>> {
    await this.ready;
    const queue = this.queues.get(targetId);
    if (!queue) {
      this.queues.set(targetId, []);
      try {
        await this.persistent.acquire(targetId, ownerId, sessionId, timeoutMs);
      } catch (error) {
        const waiters = this.queues.get(targetId) ?? [];
        this.queues.delete(targetId);
        for (const waiter of waiters) waiter.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return this.releaseOnce(targetId, sessionId);
    }
    if (timeoutMs === 0) throw new TargetLockTimeoutError(targetId, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const waiter: LockWaiter = { ownerId, sessionId, resolve, reject };
      waiter.timeout = setTimeout(() => {
        const current = this.queues.get(targetId);
        const index = current?.indexOf(waiter) ?? -1;
        if (index >= 0) current!.splice(index, 1);
        reject(new TargetLockTimeoutError(targetId, timeoutMs));
      }, timeoutMs);
      waiter.timeout.unref();
      queue.push(waiter);
    });
    return this.releaseOnce(targetId, sessionId);
  }

  isLocked(targetId: string): boolean {
    return this.queues.has(targetId);
  }

  cancelOwner(ownerId: string): void {
    for (const [targetId, queue] of this.queues) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const waiter = queue[index]!;
        if (waiter.ownerId !== ownerId) continue;
        queue.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.reject(new TargetLockTimeoutError(targetId, 0, { reason: "owner disconnected" }));
      }
    }
  }

  private releaseOnce(targetId: string, sessionId: string): () => Promise<void> {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const queue = this.queues.get(targetId);
      const next = queue?.shift();
      if (next) {
        clearTimeout(next.timeout);
        await this.persistent.handoff(targetId, next.ownerId, next.sessionId);
        next.resolve();
      } else {
        this.queues.delete(targetId);
        await this.persistent.release(targetId, sessionId);
      }
    };
  }
}
