import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoUtilities } from '../../src/automation/video-utilities.js';
import { CommandRunner } from '../../src/infrastructure/command-runner.js';

describe('VideoUtilities', () => {
    let directory: string;
    let input: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'browser-testbench-video-utilities-'));
        input = join(directory, 'recording.mp4');
        await writeFile(input, 'source');
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('preserves source timestamps while repairing a viewport recording duration', async () => {
        const run = vi
            .spyOn(CommandRunner, 'run')
            .mockImplementation(async (_command, args = []) => {
                await writeFile(args.at(-1)!, 'transformed');
                return { code: 0, stdout: '', stderr: '' };
            });

        await VideoUtilities.crop(
            input,
            {
                x: 0,
                y: 120,
                width: 1080,
                height: 2070,
                coordinateSystem: 'video-pixels',
                edges: 'left-top-inclusive-right-bottom-exclusive',
            },
            19_300,
        );

        const filter = run.mock.calls[0]?.[1]?.[4] ?? '';
        expect(filter).toContain('setpts=PTS-STARTPTS,fps=30');
        expect(filter).not.toContain('setpts=N/(30*TB)');
    });

    it('preserves source timestamps while repairing a full-screen recording duration', async () => {
        const run = vi
            .spyOn(CommandRunner, 'run')
            .mockImplementation(async (_command, args = []) => {
                await writeFile(args.at(-1)!, 'transformed');
                return { code: 0, stdout: '', stderr: '' };
            });

        await VideoUtilities.normalizeDuration(input, 19_300);

        const filter = run.mock.calls[0]?.[1]?.[4] ?? '';
        expect(filter).toContain('setpts=PTS-STARTPTS,fps=30');
        expect(filter).not.toContain('setpts=N/(30*TB)');
    });
});
