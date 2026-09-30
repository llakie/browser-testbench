import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetConfig } from '../config/types.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import { RecordingSettingsStore } from './settings-store.js';
import type { BrowserHandle } from '../automation/browser-session.js';
import type { GeometrySample } from './geometry.js';
import { ObsCapture, type PreparedObsCapture } from './obs-capture.js';
import { ObsViewport } from './obs-viewport.js';
import { ObsWorkspace, OBS_SCENE } from './obs-workspace.js';
import { OperationWait } from '../automation/operation-wait.js';

export class ObsRecorder {
    private workspace?: ObsWorkspace;
    private readonly capture = new ObsCapture();
    private directory?: string;
    private started = false;
    startedAtMonotonicMs = 0;

    static async start(
        target: TargetConfig,
        browser: BrowserHandle,
        outputPath: string,
        geometry: GeometrySample,
        scope: 'viewport' | 'screen',
        preparedCapture?: PreparedObsCapture,
    ): Promise<ObsRecorder> {
        const recorder = new ObsRecorder(outputPath, preparedCapture);

        try {
            recorder.workspace = preparedCapture?.workspace ?? (await ObsWorkspace.open());
            await recorder.prepare(target, browser, geometry, scope);
            const obs = recorder.workspace.obs;
            await obs.call('StartRecord');
            recorder.started = true;
            await OperationWait.until(
                async () => {
                    const before = performance.now();
                    const status = await obs.call('GetRecordStatus');
                    recorder.startedAtMonotonicMs =
                        (before + performance.now()) / 2 - status.outputDuration;
                    return (
                        status.outputActive && status.outputBytes > 0 && status.outputDuration > 0
                    );
                },
                { operation: 'recording.ready', timeoutMs: 10_000 },
            );
            return recorder;
        } catch (error) {
            await recorder.cleanup();
            throw error;
        }
    }

    private constructor(
        private readonly outputPath: string,
        private readonly preparedCapture?: PreparedObsCapture,
    ) {}

    private async prepare(
        target: TargetConfig,
        browser: BrowserHandle,
        geometry: GeometrySample,
        scope: 'viewport' | 'screen',
    ): Promise<void> {
        const workspace = this.workspace!;
        const obs = workspace.obs;
        const { source: sourceName, sceneItemId } =
            this.preparedCapture ??
            (await this.capture.prepare(
                workspace,
                target,
                browser,
                await RecordingSettingsStore.read(target),
            ));
        const viewport = await ObsViewport.measure(obs, browser, sourceName, workspace.id);
        const native = geometry.viewportInVideo;
        const scaleX = viewport.width / native.width;
        const scaleY = viewport.height / native.height;
        const bounds =
            scope === 'viewport'
                ? viewport
                : {
                      x: viewport.x - native.x * scaleX,
                      y: viewport.y - native.y * scaleY,
                      width: geometry.video.width * scaleX,
                      height: geometry.video.height * scaleY,
                  };
        const size = scope === 'viewport' ? native : geometry.video;
        const width = Math.ceil(size.width / 2) * 2;
        const height = Math.ceil(size.height / 2) * 2;
        const { sceneItemTransform: source } = await obs.call('GetSceneItemTransform', {
            sceneName: OBS_SCENE,
            sceneItemId,
        });
        await obs.call('SetVideoSettings', {
            baseWidth: width,
            baseHeight: height,
            outputWidth: width,
            outputHeight: height,
            fpsNumerator: 30,
            fpsDenominator: 1,
        });
        await obs.call('SetSceneItemTransform', {
            sceneName: OBS_SCENE,
            sceneItemId,
            sceneItemTransform: {
                positionX: 0,
                positionY: 0,
                alignment: 5,
                boundsType: 'OBS_BOUNDS_NONE',
                cropLeft: Math.round(bounds.x),
                cropTop: Math.round(bounds.y),
                cropRight: Math.round(Number(source.sourceWidth) - bounds.x - bounds.width),
                cropBottom: Math.round(Number(source.sourceHeight) - bounds.y - bounds.height),
                scaleX: width / bounds.width,
                scaleY: height / bounds.height,
            },
        });

        this.directory = await mkdtemp(join(tmpdir(), 'testbench-obs-'));
        await obs.call('SetProfileParameter', {
            parameterCategory: 'Output',
            parameterName: 'Mode',
            parameterValue: 'Simple',
        });
        await obs.call('SetProfileParameter', {
            parameterCategory: 'SimpleOutput',
            parameterName: 'RecQuality',
            parameterValue: 'HQ',
        });
        await obs.call('SetProfileParameter', {
            parameterCategory: 'SimpleOutput',
            parameterName: 'RecFormat2',
            parameterValue: 'mkv',
        });
        await obs.call('SetRecordDirectory', { recordDirectory: this.directory });
        await obs.call('SetProfileParameter', {
            parameterCategory: 'SimpleOutput',
            parameterName: 'RecEncoder',
            parameterValue: 'x264',
        });
        await workspace.reloadProfile();
    }

    async stop(): Promise<void> {
        let remuxed = false;

        try {
            const outputPath = await this.workspace!.obs.stopRecording();
            this.started = false;
            const result = await CommandRunner.run('ffmpeg', [
                '-y',
                '-i',
                outputPath,
                '-map',
                '0:v:0',
                '-map',
                '0:a:0',
                '-c',
                'copy',
                '-movflags',
                '+faststart',
                this.outputPath,
            ]);

            if (result.code !== 0) {
                throw new Error(
                    `OBS recording could not be remuxed. Original retained at ${outputPath}: ${result.stderr}`,
                );
            }

            remuxed = true;
        } finally {
            await this.cleanup(remuxed);
        }
    }

    private async cleanup(removeRecording = false): Promise<void> {
        try {
            if (this.started) {
                await this.workspace!.obs.stopRecording();
                this.started = false;
            }
        } finally {
            try {
                await this.capture.close();
            } finally {
                if (!this.preparedCapture) {
                    await this.workspace?.close();
                }
            }

            if (removeRecording && this.directory) {
                await rm(this.directory, { recursive: true, force: true });
            }
        }
    }
}
