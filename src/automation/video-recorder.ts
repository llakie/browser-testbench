import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TargetConfig } from '../config/types.js';
import { TestbenchError } from '../errors/testbench-error.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import { MediaTooling } from '../infrastructure/media-tooling.js';
import type { BrowserHandle } from './browser-session.js';
import { ObsRecorder } from './obs-recorder.js';
import type { GeometrySample } from './recording-geometry.js';
import type { PreparedObsCapture } from './obs-capture.js';

export interface RecordingArtifact {
    path: string;
    size: number;
    sha256: string;
    mimeType: 'video/mp4';
    container: string;
    codec: string;
    width: number;
    height: number;
    durationMs: number;
    timeBase: string;
    averageFrameRate: number;
    frameRateMode: 'constant' | 'variable';
}

interface ProbeOutput {
    streams?: Array<{
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
        time_base?: string;
    }>;
    format?: { format_name?: string; duration?: string };
}

export class VideoRecorder {
    private stopResult?: Promise<RecordingArtifact>;
    readonly capturesAudio = true;

    private constructor(
        private readonly obs: ObsRecorder,
        private readonly outputPath: string,
    ) {}

    get startedAtMonotonicMs(): number {
        return this.obs.startedAtMonotonicMs;
    }

    static async start(
        target: TargetConfig,
        outputPath: string,
        browser: BrowserHandle,
        geometry: GeometrySample,
        scope: 'screen' | 'viewport' = 'viewport',
        preparedCapture?: PreparedObsCapture,
    ): Promise<VideoRecorder> {
        if (!MediaTooling.isAvailable()) {
            throw new TestbenchError(
                'RECORDING_UNSUPPORTED',
                'FFmpeg and ffprobe are required for recording.',
                {
                    operation: 'recording.start',
                    status: 409,
                },
            );
        }

        await mkdir(dirname(outputPath), { recursive: true });
        return new VideoRecorder(
            await ObsRecorder.start(target, browser, outputPath, geometry, scope, preparedCapture),
            outputPath,
        );
    }

    stop(signal?: AbortSignal): Promise<RecordingArtifact> {
        this.stopResult ??= this.finalize();

        if (!signal) {
            return this.stopResult;
        }

        return this.stopResult.then((artifact) => {
            if (signal.aborted) {
                throw new TestbenchError(
                    'OPERATION_ABORTED',
                    'Recording finalization was aborted after safe recorder cleanup.',
                    {
                        operation: 'recording.stop',
                        status: 499,
                        details: { partialArtifact: artifact },
                    },
                );
            }

            return artifact;
        });
    }

    private async finalize(): Promise<RecordingArtifact> {
        try {
            await this.obs.stop();
            return await RecordingProbe.inspect(this.outputPath);
        } catch (error) {
            if (error instanceof TestbenchError) {
                throw error;
            }

            const partial = await stat(this.outputPath).catch(() => undefined);
            throw new TestbenchError(
                'RECORDING_FINALIZE_FAILED',
                'Recording could not be finalized.',
                {
                    operation: 'recording.stop',
                    status: 500,
                    cause: error,
                    details: {
                        path: this.outputPath,
                        ...(partial ? { partialBytes: partial.size } : {}),
                    },
                },
            );
        }
    }
}

export class RecordingProbe {
    static async inspect(path: string): Promise<RecordingArtifact> {
        const file = await stat(path);

        if (!file.isFile() || file.size === 0) {
            throw new Error('Video recorder produced an empty file.');
        }

        const result = await CommandRunner.run('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name,width,height,avg_frame_rate,r_frame_rate,time_base:format=format_name,duration',
            '-of',
            'json',
            path,
        ]);

        if (result.code !== 0) {
            throw new Error(
                `ffprobe could not read the recording: ${result.stderr || result.stdout}`,
            );
        }

        const probe = JSON.parse(result.stdout) as ProbeOutput;
        const stream = probe.streams?.[0];

        if (!stream?.codec_name || !stream.width || !stream.height) {
            throw new Error('Recording has no readable video stream.');
        }

        const averageFrameRate = this.rate(stream.avg_frame_rate);
        const nominalFrameRate = this.rate(stream.r_frame_rate);
        const hash = createHash('sha256');

        for await (const chunk of createReadStream(path)) {
            hash.update(chunk as Buffer);
        }

        return {
            path,
            size: file.size,
            sha256: hash.digest('hex'),
            mimeType: 'video/mp4',
            container: probe.format?.format_name?.split(',')[0] ?? 'unknown',
            codec: stream.codec_name,
            width: stream.width,
            height: stream.height,
            durationMs: Math.round(Number(probe.format?.duration ?? 0) * 1_000),
            timeBase: stream.time_base ?? 'unknown',
            averageFrameRate,
            frameRateMode:
                Math.abs(averageFrameRate - nominalFrameRate) < 0.001 ? 'constant' : 'variable',
        };
    }

    private static rate(value?: string): number {
        if (!value) {
            return 0;
        }

        const [numerator, denominator = '1'] = value.split('/');
        const result = Number(numerator) / Number(denominator);
        return Number.isFinite(result) ? result : 0;
    }
}
