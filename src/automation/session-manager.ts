import { randomUUID } from "node:crypto";
import type { StartSessionInput } from "../config/input-schemas.js";
import { InteractiveController } from "./interactive-controller.js";
import { TargetCatalogService } from "../setup/target-catalog-service.js";
import { TargetLockManager } from "./target-lock-manager.js";

export interface ManagedSession {
  id: string;
  target: StartSessionInput["target"];
  createdAt: string;
  controller: InteractiveController;
  runtime: Record<string, unknown>;
  release: () => void;
}
export type PublicManagedSession = Omit<ManagedSession, "controller" | "release">;

export class SessionNotFoundError extends Error {}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly locks = new TargetLockManager();

  async start(input: StartSessionInput): Promise<PublicManagedSession> {
    const id = randomUUID();
    const controller = new InteractiveController();
    const { target, options } = await TargetCatalogService.sessionOptions(input);
    const release = target.serial ? await this.locks.acquire(target.id) : () => undefined;
    try {
      const runtime = await controller.start(options);
      const session = { id, target: target.id, createdAt: new Date().toISOString(), controller, runtime, release };
      this.sessions.set(id, session);
      return this.publicSession(session);
    } catch (error) {
      await controller.close();
      release();
      throw error;
    }
  }

  list(): PublicManagedSession[] {
    return [...this.sessions.values()].map((session) => this.publicSession(session));
  }

  get(id: string): InteractiveController {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(`Session '${id}' was not found.`);
    return session.controller;
  }

  async close(id: string): Promise<{ videoPath?: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(`Session '${id}' was not found.`);
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
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await session.controller.close();
        } finally {
          session.release();
        }
      }),
    );
  }

  private publicSession(session: ManagedSession): PublicManagedSession {
    return {
      id: session.id,
      target: session.target,
      createdAt: session.createdAt,
      runtime: session.runtime,
    };
  }
}
