import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionManager } from '../automation/session-manager.js';

type RecordingResult = Awaited<ReturnType<SessionManager['stopRecording']>>;
type PublicRecording = Omit<RecordingResult, 'path'> & { artifactId?: string };

export class RecordingArtifacts {
    private readonly recordingDirectories = new Map<string, string>();
    private readonly explicitRecordingSessions = new Set<string>();
    private readonly recordingArtifacts = new Map<
        string,
        {
            ownerId: string;
            sessionId: string;
            directory: string;
            result: RecordingResult;
        }
    >();

    isExplicit(sessionId: string): boolean {
        return this.explicitRecordingSessions.has(sessionId);
    }

    async start<T>(
        sessionId: string,
        fileName: string,
        start: (outputPath: string) => Promise<T>,
    ): Promise<T> {
        const directory = await mkdtemp(join(tmpdir(), 'browser-testbench-recording-'));

        try {
            const result = await start(join(directory, basename(fileName.replaceAll('\\', '/'))));
            this.recordingDirectories.set(sessionId, directory);
            this.explicitRecordingSessions.add(sessionId);
            return result;
        } catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw error;
        }
    }

    async finish(
        sessionId: string,
        ownerId: string,
        stop: () => Promise<RecordingResult>,
    ): Promise<PublicRecording> {
        const existing = [...this.recordingArtifacts.entries()].find(
            ([, artifact]) => artifact.sessionId === sessionId && artifact.ownerId === ownerId,
        );

        if (existing) {
            const [artifactId, artifact] = existing;
            return { ...RecordingArtifacts.publicResult(artifact.result), artifactId };
        }

        const result = await stop();
        const directory = this.recordingDirectories.get(sessionId);

        if (!directory) {
            return RecordingArtifacts.publicResult(result);
        }

        const artifactId = randomUUID();
        this.recordingDirectories.delete(sessionId);
        this.recordingArtifacts.set(artifactId, { ownerId, sessionId, directory, result });
        return { ...RecordingArtifacts.publicResult(result), artifactId };
    }

    get(sessionId: string, ownerId: string, artifactId: string) {
        const artifact = this.recordingArtifacts.get(artifactId);
        return artifact?.sessionId === sessionId && artifact.ownerId === ownerId
            ? artifact
            : undefined;
    }

    async discard(artifactId: string): Promise<void> {
        const artifact = this.recordingArtifacts.get(artifactId);

        if (!artifact) {
            return;
        }

        this.recordingArtifacts.delete(artifactId);
        await rm(artifact.directory, { recursive: true, force: true });
    }

    async cleanupSession(sessionId: string): Promise<void> {
        const directories = new Set<string>();
        const active = this.recordingDirectories.get(sessionId);

        if (active) {
            directories.add(active);
        }

        this.recordingDirectories.delete(sessionId);
        this.explicitRecordingSessions.delete(sessionId);

        for (const [artifactId, artifact] of this.recordingArtifacts) {
            if (artifact.sessionId !== sessionId) {
                continue;
            }

            directories.add(artifact.directory);
            this.recordingArtifacts.delete(artifactId);
        }

        await Promise.all(
            [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
        );
    }

    async cleanup(): Promise<void> {
        const sessionIds = new Set([
            ...this.explicitRecordingSessions,
            ...this.recordingDirectories.keys(),
            ...[...this.recordingArtifacts.values()].map((artifact) => artifact.sessionId),
        ]);
        await Promise.all([...sessionIds].map((sessionId) => this.cleanupSession(sessionId)));
    }

    private static publicResult(result: RecordingResult): Omit<RecordingResult, 'path'> {
        const { path: _serverPath, ...publicResult } = result;
        return publicResult;
    }
}
