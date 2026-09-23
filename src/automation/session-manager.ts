import { randomUUID } from "node:crypto";
import type { StartSessionInput } from "../config/input-schemas.js";
import { InteractiveController } from "./interactive-controller.js";
import { TargetCatalogService } from "../setup/target-catalog-service.js";
import { TargetLockManager } from "./target-lock-manager.js";
import { TestbenchDefaults } from "../config/defaults.js";

export interface ManagedSession {
  id: string;
  target: StartSessionInput["target"];
  createdAt: string;
  ownerId: string;
  controller: InteractiveController;
  runtime: Record<string, unknown>;
  release: () => void;
}
export type PublicManagedSession = Omit<ManagedSession, "controller" | "release" | "ownerId">;

export class SessionNotFoundError extends Error {}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly locks = new TargetLockManager();

  async start(input: StartSessionInput, ownerId = "local", signal?: AbortSignal): Promise<PublicManagedSession> {
    const id = randomUUID();
    const controller = new InteractiveController();
    const { target, options } = await TargetCatalogService.sessionOptions(input);
    const release = target.serial
      ? await this.locks.acquire(target.id, input.lockTimeoutMs ?? TestbenchDefaults.TARGET_LOCK_TIMEOUT_MS, ownerId)
      : () => undefined;
    try {
      signal?.throwIfAborted();
      const runtime = await controller.start(options);
      signal?.throwIfAborted();
      const session = {
        id,
        target: target.id,
        createdAt: new Date().toISOString(),
        ownerId,
        controller,
        runtime,
        release,
      };
      this.sessions.set(id, session);
      return this.publicSession(session);
    } catch (error) {
      try {
        await controller.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Session startup failed and cleanup also failed.", {
          cause: error,
        });
      } finally {
        release();
      }
      throw error;
    }
  }

  list(ownerId?: string): PublicManagedSession[] {
    return [...this.sessions.values()]
      .filter((session) => !ownerId || session.ownerId === ownerId)
      .map((session) => this.publicSession(session));
  }

  get(id: string, ownerId?: string): InteractiveController {
    const session = this.sessions.get(id);
    if (!session || (ownerId && session.ownerId !== ownerId))
      throw new SessionNotFoundError(`Session '${id}' was not found.`);
    return session.controller;
  }

  async run<T>(id: string, action: (controller: InteractiveController) => Promise<T>, ownerId?: string): Promise<T> {
    const controller = this.get(id, ownerId);
    try {
      return await action(controller);
    } catch (error) {
      if (SessionManager.isTerminatedSessionError(error)) await this.discard(id);
      throw error;
    }
  }

  async close(id: string, ownerId?: string): Promise<{ videoPath?: string }> {
    const session = this.sessions.get(id);
    if (!session || (ownerId && session.ownerId !== ownerId))
      throw new SessionNotFoundError(`Session '${id}' was not found.`);
    this.sessions.delete(id);
    try {
      return await session.controller.close();
    } finally {
      session.release();
    }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        try {
          await session.controller.close();
        } finally {
          session.release();
        }
      }),
    );
    this.throwCloseFailure(results);
  }

  async closeOwned(ownerId: string): Promise<void> {
    this.locks.cancelOwner(ownerId);
    const sessions = [...this.sessions.values()].filter((session) => session.ownerId === ownerId);
    const results = await Promise.allSettled(sessions.map((session) => this.close(session.id, ownerId)));
    this.throwCloseFailure(results);
  }

  isTargetBusy(targetId: string): boolean {
    return this.locks.isLocked(targetId);
  }

  static isTerminatedSessionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const description = `${error.name} ${error.message}`.toLowerCase();
    return (
      description.includes("invalid session id") ||
      description.includes("no such session") ||
      description.includes("nosuchsession") ||
      description.includes("session is either terminated or not started")
    );
  }

  private async discard(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      await session.controller.close();
    } finally {
      session.release();
    }
  }

  private publicSession(session: ManagedSession): PublicManagedSession {
    return {
      id: session.id,
      target: session.target,
      createdAt: session.createdAt,
      runtime: session.runtime,
    };
  }

  private throwCloseFailure(results: PromiseSettledResult<unknown>[]): void {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
