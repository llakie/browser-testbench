import { randomUUID } from "node:crypto";
import type { StartSessionInput } from "../config/input-schemas.js";
import { InteractiveController } from "./interactive-controller.js";
import { TargetCatalogService } from "../setup/target-catalog-service.js";
import { TargetLockManager } from "./target-lock-manager.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { AndroidMediaUtilities, type CameraImageResource } from "./android-media-utilities.js";
import type { RecordingArtifact } from "./video-recorder.js";

export interface ManagedSession {
  id: string;
  target: StartSessionInput["target"];
  createdAt: string;
  ownerId: string;
  controller: InteractiveController;
  runtime: Record<string, unknown>;
  release: () => Promise<void>;
  leaseTimeoutMs: number;
  leaseExpiresAt: string;
  lease?: NodeJS.Timeout;
  monotonicStartedAt: number;
  markSequence: number;
  marks: SessionMark[];
  recording?: { id: string; startedSessionTimeMs: number };
}
export type PublicManagedSession = Omit<
  ManagedSession,
  "controller" | "release" | "ownerId" | "lease" | "monotonicStartedAt" | "markSequence" | "marks" | "recording"
> & { sessionTimeMs: number };

export interface SessionMark {
  name: string;
  data?: Record<string, unknown>;
  sequence: number;
  sessionTimeMs: number;
  wallTime: string;
  recordingTimeMs?: number;
}

export class SessionNotFoundError extends Error {}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly closures = new Map<string, { ownerId: string; result: Promise<{ videoPath?: string }> }>();
  private readonly expired = new Set<string>();
  private readonly locks = new TargetLockManager();

  async start(
    input: StartSessionInput,
    ownerId = "local",
    signal?: AbortSignal,
    resources: { cameraImage?: CameraImageResource } = {},
  ): Promise<PublicManagedSession> {
    const id = randomUUID();
    const controller = new InteractiveController();
    const { target, options } = await TargetCatalogService.sessionOptions(input);
    const camera = resources.cameraImage
      ? await AndroidMediaUtilities.prepare(target, resources.cameraImage, options.capabilities)
      : undefined;
    if (camera) options.capabilities = camera.capabilities;
    const release = target.serial
      ? await this.locks.acquire(
          target.id,
          input.lockTimeoutMs ?? TestbenchDefaults.TARGET_LOCK_TIMEOUT_MS,
          ownerId,
          id,
        )
      : async () => undefined;
    try {
      signal?.throwIfAborted();
      const runtime = await controller.start(options);
      if (camera) {
        const capabilities = runtime.capabilities;
        if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
          const { "appium:avdArgs": _privateMediaArguments, ...publicCapabilities } = capabilities as Record<
            string,
            unknown
          >;
          runtime.capabilities = publicCapabilities;
        }
        runtime.media = { camera: camera.metadata };
      }
      signal?.throwIfAborted();
      const session = {
        id,
        target: target.id,
        createdAt: new Date().toISOString(),
        ownerId,
        controller,
        runtime,
        release,
        leaseTimeoutMs: input.leaseTimeoutMs ?? TestbenchDefaults.SESSION_LEASE_TIMEOUT_MS,
        leaseExpiresAt: "",
        monotonicStartedAt: performance.now(),
        markSequence: 0,
        marks: [],
      };
      this.refreshLease(session);
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
        await release();
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
    if (!session && this.expired.has(id))
      throw new TestbenchError("SESSION_LEASE_EXPIRED", `Session '${id}' expired.`, {
        operation: "session.access",
        sessionId: id,
        status: 410,
      });
    if (!session || (ownerId && session.ownerId !== ownerId))
      throw new SessionNotFoundError(`Session '${id}' was not found.`);
    return session.controller;
  }

  async run<T>(id: string, action: (controller: InteractiveController) => Promise<T>, ownerId?: string): Promise<T> {
    const controller = this.get(id, ownerId);
    this.touch(id, ownerId);
    try {
      return await action(controller);
    } catch (error) {
      if (SessionManager.isTerminatedSessionError(error)) await this.discard(id);
      throw error;
    }
  }

  async close(id: string, ownerId?: string): Promise<{ videoPath?: string }> {
    const existing = this.closures.get(id);
    if (existing) {
      if (ownerId && existing.ownerId !== ownerId) throw new SessionNotFoundError(`Session '${id}' was not found.`);
      return existing.result;
    }
    const session = this.sessions.get(id);
    if (!session || (ownerId && session.ownerId !== ownerId))
      throw new SessionNotFoundError(`Session '${id}' was not found.`);
    const result = this.closeSession(session);
    this.rememberClosure(id, session.ownerId, result);
    return result;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(sessions.map((session) => this.close(session.id, session.ownerId)));
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

  touch(id: string, ownerId?: string): PublicManagedSession {
    const session = this.sessions.get(id);
    if (!session || (ownerId && session.ownerId !== ownerId))
      throw new SessionNotFoundError(`Session '${id}' was not found.`);
    this.refreshLease(session);
    return this.publicSession(session);
  }

  mark(id: string, name: string, data?: Record<string, unknown>, ownerId?: string): SessionMark {
    const session = this.managed(id, ownerId);
    this.refreshLease(session);
    const mark = {
      name,
      ...(data ? { data } : {}),
      sequence: ++session.markSequence,
      sessionTimeMs: this.sessionTime(session),
      wallTime: new Date().toISOString(),
      ...(session.recording
        ? { recordingTimeMs: Math.max(0, this.sessionTime(session) - session.recording.startedSessionTimeMs) }
        : {}),
    };
    session.marks.push(mark);
    return mark;
  }

  async startRecording(
    id: string,
    options: { outputPath: string; scope: "screen" | "viewport" },
    ownerId?: string,
  ): Promise<Awaited<ReturnType<InteractiveController["startRecording"]>> & { sessionTimeMs: number }> {
    const session = this.managed(id, ownerId);
    this.refreshLease(session);
    const result = await session.controller.startRecording(options);
    const sessionTimeMs = this.sessionTime(session);
    result.geometry.samples[0]!.sessionTimeMs = sessionTimeMs;
    session.recording = { id: result.id, startedSessionTimeMs: sessionTimeMs };
    return { ...result, sessionTimeMs };
  }

  async stopRecording(
    id: string,
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<
    RecordingArtifact & {
      id: string;
      requestedScope: "screen" | "viewport";
      actualScope: "screen" | "viewport";
      startedSessionTimeMs?: number;
      endedSessionTimeMs: number;
      marks: SessionMark[];
    }
  > {
    const session = this.managed(id, ownerId);
    this.refreshLease(session);
    const active = session.recording;
    const result = await session.controller.stopRecording(signal);
    const endedSessionTimeMs = this.sessionTime(session);
    for (const sample of result.geometry.samples) sample.sessionTimeMs ??= endedSessionTimeMs;
    session.recording = undefined;
    return {
      ...result,
      ...(active ? { startedSessionTimeMs: active.startedSessionTimeMs } : {}),
      endedSessionTimeMs,
      marks: active
        ? session.marks.filter(
            (mark) => mark.sessionTimeMs >= active.startedSessionTimeMs && mark.sessionTimeMs <= endedSessionTimeMs,
          )
        : [],
    };
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
    await this.close(id, session.ownerId);
  }

  private publicSession(session: ManagedSession): PublicManagedSession {
    return {
      id: session.id,
      target: session.target,
      createdAt: session.createdAt,
      runtime: session.runtime,
      leaseTimeoutMs: session.leaseTimeoutMs,
      leaseExpiresAt: session.leaseExpiresAt,
      sessionTimeMs: this.sessionTime(session),
    };
  }

  private managed(id: string, ownerId?: string): ManagedSession {
    this.get(id, ownerId);
    return this.sessions.get(id)!;
  }

  private sessionTime(session: ManagedSession): number {
    return Math.max(0, performance.now() - session.monotonicStartedAt);
  }

  private refreshLease(session: ManagedSession): void {
    clearTimeout(session.lease);
    session.leaseExpiresAt = new Date(Date.now() + session.leaseTimeoutMs).toISOString();
    session.lease = setTimeout(() => {
      this.expired.add(session.id);
      void this.close(session.id, session.ownerId).catch((error) =>
        console.error(
          `Expired session '${session.id}' cleanup failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    }, session.leaseTimeoutMs);
    session.lease.unref();
  }

  private async closeSession(session: ManagedSession): Promise<{ videoPath?: string }> {
    this.sessions.delete(session.id);
    clearTimeout(session.lease);
    try {
      return await session.controller.close();
    } finally {
      await session.release();
    }
  }

  private rememberClosure(id: string, ownerId: string, result: Promise<{ videoPath?: string }>): void {
    this.closures.set(id, { ownerId, result });
    if (this.closures.size <= 100) return;
    const oldest = this.closures.keys().next().value as string | undefined;
    if (oldest) {
      this.closures.delete(oldest);
      this.expired.delete(oldest);
    }
  }

  private throwCloseFailure(results: PromiseSettledResult<unknown>[]): void {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
