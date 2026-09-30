import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { RecordingArtifacts } from '../../src/recording/artifacts.js';
import type { SessionManager } from '../../src/automation/session-manager.js';

describe('RecordingArtifacts', () => {
    const artifacts = new RecordingArtifacts();

    afterEach(async () => {
        await artifacts.cleanup();
    });

    it('isolates filenames and removes temporary files after a failed start', async () => {
        let output = '';
        await expect(
            artifacts.start('session', '../../outside.mp4', async (path) => {
                output = path;
                throw new Error('Recorder unavailable');
            }),
        ).rejects.toThrow('Recorder unavailable');
        expect(basename(output)).toBe('outside.mp4');
        expect(dirname(output)).toContain('browser-testbench-recording-');
        await expect(stat(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(artifacts.isExplicit('session')).toBe(false);
    });

    it('caches a finished recording without exposing server paths and checks ownership', async () => {
        const path = await artifacts.start(
            'session',
            'C:\\exports\\video.mp4',
            async (path) => path,
        );
        const result = { path, size: 123 } as Awaited<ReturnType<SessionManager['stopRecording']>>;
        const stop = vi.fn().mockResolvedValue(result);
        const finished = await artifacts.finish('session', 'owner', stop);

        expect(basename(path)).toBe('video.mp4');
        expect(finished).toEqual({ size: 123, artifactId: expect.any(String) });
        await expect(artifacts.finish('session', 'owner', stop)).resolves.toEqual(finished);
        expect(stop).toHaveBeenCalledOnce();
        expect(artifacts.get('session', 'other', finished.artifactId!)).toBeUndefined();
        expect(artifacts.get('other', 'owner', finished.artifactId!)).toBeUndefined();
        expect(artifacts.get('session', 'owner', finished.artifactId!)?.result).toBe(result);

        await artifacts.discard(finished.artifactId!);
        expect(artifacts.get('session', 'owner', finished.artifactId!)).toBeUndefined();
        await expect(stat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(artifacts.isExplicit('session')).toBe(true);
        await artifacts.cleanupSession('session');
        expect(artifacts.isExplicit('session')).toBe(false);
    });

    it('retains a failed finalization for retry and cleans active and completed sessions', async () => {
        const active = await artifacts.start('active', 'active.mp4', async (path) => path);
        const completed = await artifacts.start('completed', 'completed.mp4', async (path) => path);
        await expect(
            artifacts.finish('active', 'owner', async () => {
                throw new Error('Retry stop');
            }),
        ).rejects.toThrow('Retry stop');
        await expect(stat(dirname(active))).resolves.toBeDefined();
        const finished = await artifacts.finish(
            'completed',
            'owner',
            async () =>
                ({ path: completed }) as Awaited<ReturnType<SessionManager['stopRecording']>>,
        );

        await artifacts.cleanup();

        await expect(stat(dirname(active))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(dirname(completed))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(artifacts.get('completed', 'owner', finished.artifactId!)).toBeUndefined();
        expect(artifacts.isExplicit('active')).toBe(false);
    });
});
