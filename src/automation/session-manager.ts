import { randomUUID } from "node:crypto";
import type { StartSessionInput } from "../config/input-schemas.js";
import { InteractiveController } from "./interactive-controller.js";

export interface ManagedSession {
  id: string;
  target: StartSessionInput["target"];
  createdAt: string;
  controller: InteractiveController;
  runtime: Record<string, unknown>;
}

export class SessionNotFoundError extends Error {}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  async start(input: StartSessionInput): Promise<Omit<ManagedSession, "controller">> {
    const id = randomUUID();
    const controller = new InteractiveController();
    try {
      const runtime = await controller.start(input);
      const session = { id, target: input.target, createdAt: new Date().toISOString(), controller, runtime };
      this.sessions.set(id, session);
      return this.publicSession(session);
    } catch (error) {
      await controller.close();
      throw error;
    }
  }

  list(): Array<Omit<ManagedSession, "controller">> {
    return [...this.sessions.values()].map((session) => this.publicSession(session));
  }

  get(id: string): InteractiveController {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(`Session '${id}' was not found.`);
    return session.controller;
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(`Session '${id}' was not found.`);
    this.sessions.delete(id);
    await session.controller.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.controller.close()));
  }

  private publicSession(session: ManagedSession): Omit<ManagedSession, "controller"> {
    return {
      id: session.id,
      target: session.target,
      createdAt: session.createdAt,
      runtime: session.runtime,
    };
  }
}
