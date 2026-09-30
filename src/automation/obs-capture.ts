import { spawn, type ChildProcess } from 'node:child_process';
import type { TargetConfig } from '../config/types.js';
import type { RecordingSettings } from '../config/recording-settings.js';
import { AndroidSdk } from '../infrastructure/android-sdk.js';
import { ProcessTerminator } from '../infrastructure/process-terminator.js';
import { AndroidDeviceUtilities } from './android-device-utilities.js';
import type { BrowserHandle } from './browser-session.js';
import { ObsIosCapture, IOS_CAPTURE_SOURCE } from './obs-ios-capture.js';
import { ObsWorkspace } from './obs-workspace.js';
import { OperationWait } from './operation-wait.js';
import { LocalizedError } from '../i18n/translator.js';
import { RecordingSettingsStore } from '../setup/recording-settings-store.js';

const WINDOW = 'Testbench Window';
const AUDIO = 'Testbench System Audio';

export interface PreparedObsCapture {
    workspace: ObsWorkspace;
    source: string;
    sceneItemId: number;
}

export class ObsCapture {
    private mirror?: ChildProcess;
    private mirrorError = '';
    private mirrorLog = '';

    static async prepareIosSession(target: TargetConfig): Promise<PreparedObsCapture> {
        const workspace = await ObsWorkspace.open();

        try {
            const settings = await RecordingSettingsStore.read(target);
            const source = await new ObsCapture().prepare(workspace, target, undefined, settings);
            return { workspace, ...source };
        } catch (error) {
            await workspace.close();
            throw error;
        }
    }

    async prepare(
        workspace: ObsWorkspace,
        target: TargetConfig,
        browser: BrowserHandle | undefined,
        settings: RecordingSettings,
    ): Promise<{ source: string; sceneItemId: number }> {
        const physicalIos = target.name === 'safari-ios' && target.deviceKind === 'physical';

        if (!physicalIos && !browser) {
            throw new Error('Window capture requires an open browser.');
        }

        const sceneItemId = physicalIos
            ? await ObsIosCapture.prepare(workspace, settings.captureDeviceId)
            : await this.window(workspace, target, browser!);
        const source = physicalIos ? IOS_CAPTURE_SOURCE : WINDOW;
        const audio = physicalIos ? source : AUDIO;
        let audioSceneItemId: number | undefined;

        if (!physicalIos) {
            if (process.platform === 'darwin') {
                await workspace.obs.call('SetInputMute', { inputName: source, inputMuted: true });
            }

            const kind =
                process.platform === 'darwin'
                    ? 'sck_audio_capture'
                    : process.platform === 'win32'
                      ? 'wasapi_output_capture'
                      : 'pulse_output_capture';
            audioSceneItemId = await workspace.input(
                AUDIO,
                kind,
                process.platform === 'darwin' ? { type: 0 } : { device_id: 'default' },
            );
        }

        await workspace.obs.call('SetInputAudioSyncOffset', {
            inputName: audio,
            inputAudioSyncOffset: settings.audioSyncOffsetMs,
        });
        await workspace.obs.call('SetInputVolume', { inputName: audio, inputVolumeMul: 1 });
        await workspace.obs.call('SetInputMute', { inputName: audio, inputMuted: false });

        if (audioSceneItemId !== undefined) {
            await workspace.enable(audioSceneItemId);
        }

        await workspace.enable(sceneItemId);
        await workspace.reloadSources();
        return { source, sceneItemId };
    }

    private async window(
        workspace: ObsWorkspace,
        target: TargetConfig,
        browser: BrowserHandle,
    ): Promise<number> {
        const platform = process.platform;
        const kind =
            platform === 'darwin'
                ? 'screen_capture'
                : platform === 'win32'
                  ? 'window_capture'
                  : 'xcomposite_input';
        const property = platform === 'linux' ? 'capture_window' : 'window';
        const { inputKinds } = await workspace.obs.call('GetInputKindList');

        if (!inputKinds.includes(kind)) {
            throw new LocalizedError({ key: 'recording.errors.windowCapture' }, 409);
        }

        const sceneItemId = await workspace.input(
            WINDOW,
            kind,
            platform === 'darwin'
                ? { type: 1, show_cursor: false }
                : { cursor: false, show_cursor: false, capture_audio: false },
        );
        const mobile = target.name === 'safari-ios' || target.name === 'chrome-android';
        const mirrored = target.name === 'chrome-android' && target.deviceKind === 'physical';
        const title =
            !mobile || mirrored
                ? workspace.id
                : target.name === 'chrome-android'
                  ? target.avd
                  : target.deviceName;

        if (!title) {
            throw new LocalizedError({ key: 'recording.errors.windowName' }, 409);
        }

        if (mirrored) {
            await this.startMirror(target, browser, title);
        }

        const previousTitle = await browser.execute<string>('return document.title;');

        try {
            if (!mobile) {
                await browser.execute('document.title = arguments[0];', title);
            }

            await OperationWait.until(
                async () => {
                    if (this.mirror && (this.mirror.exitCode !== null || this.mirrorError)) {
                        throw new LocalizedError(
                            {
                                key: 'recording.errors.mirror',
                                parameters: { diagnostic: this.mirrorError || this.mirrorLog },
                            },
                            409,
                        );
                    }

                    const { propertyItems } = await workspace.obs.call(
                        'GetInputPropertiesListPropertyItems',
                        { inputName: WINDOW, propertyName: property },
                    );
                    const matches = propertyItems.filter(
                        (item) => item.itemEnabled && String(item.itemName).includes(title),
                    );

                    if (matches.length !== 1) {
                        return false;
                    }

                    await workspace.obs.call('SetInputSettings', {
                        inputName: WINDOW,
                        inputSettings: { [property]: matches[0]!.itemValue! },
                    });
                    return true;
                },
                { operation: 'recording.window', timeoutMs: 15_000 },
            );
        } finally {
            if (!mobile) {
                await browser.execute('document.title = arguments[0];', previousTitle);
            }
        }

        return sceneItemId;
    }

    private async startMirror(
        target: TargetConfig,
        browser: BrowserHandle,
        title: string,
    ): Promise<void> {
        const root = await AndroidSdk.root();

        if (!root) {
            throw new LocalizedError({ key: 'recording.errors.androidSdk' }, 409);
        }

        const adb = AndroidSdk.adb(root);
        const serial = await AndroidDeviceUtilities.serial(adb, target, browser.capabilities);

        if (!serial) {
            throw new LocalizedError({ key: 'recording.errors.androidDevice' }, 409);
        }

        this.mirror = spawn(
            'scrcpy',
            [
                '--serial',
                serial,
                '--window-title',
                title,
                '--no-control',
                '--require-audio',
                '--max-fps=30',
            ],
            {
                env: { ...process.env, ADB: adb },
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            },
        );
        this.mirror.on('error', (error) => {
            this.mirrorError = error.message;
        });
        this.mirror.stderr?.on('data', (data: Buffer) => {
            this.mirrorLog = `${this.mirrorLog}${data.toString()}`.slice(-2_000);
        });
    }

    async close(): Promise<void> {
        if (this.mirror) {
            await ProcessTerminator.stop(this.mirror, { graceMs: 5_000 });
        }
    }
}
