import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserHandle } from '../../src/automation/browser-session.js';
import { ObsRecorder } from '../../src/recording/obs-recorder.js';
import { ObsWorkspace } from '../../src/recording/obs-workspace.js';
import { ObsCapture } from '../../src/recording/obs-capture.js';
import { ObsViewport } from '../../src/recording/obs-viewport.js';
import type { GeometrySample } from '../../src/recording/geometry.js';
import { PersistentTargetLock } from '../../src/automation/target-lock-manager.js';
import { CommandRunner } from '../../src/infrastructure/command-runner.js';
import { ObsConnection } from '../../src/recording/obs-connection.js';
import { RecordingSettingsStore } from '../../src/recording/settings-store.js';

describe('ObsRecorder', () => {
    const directories: string[] = [];
    const inputs = new Map<
        string,
        { inputName: string; sourceName: string; sceneItemId: number }
    >();
    let title = 'Application';
    let active = false;
    const call = vi.fn();
    const close = vi.fn();
    const stopRecording = vi.fn();
    const browser = {
        execute: vi.fn(async (_script: string, value?: string) => {
            if (value !== undefined) {
                title = value;
            }

            return title;
        }),
    } as unknown as BrowserHandle;
    const geometry = {
        viewportInVideo: { x: 0, y: 0, width: 960, height: 640 },
        video: { width: 960, height: 640 },
    } as GeometrySample;

    beforeEach(() => {
        inputs.clear();
        title = 'Application';
        active = false;
        call.mockReset();
        vi.spyOn(RecordingSettingsStore, 'read').mockResolvedValue({ audioSyncOffsetMs: 90 });
        close.mockReset().mockResolvedValue(undefined);
        stopRecording.mockReset().mockImplementation(async () => {
            active = false;
            return join(directories.at(-1)!, 'source.mkv');
        });
        vi.spyOn(ObsConnection, 'connect').mockResolvedValue({
            call,
            close,
            stopRecording,
            startRecording: async () => {
                await call('StartRecord');
                return 1234;
            },
        } as never);
        vi.spyOn(PersistentTargetLock.prototype, 'acquire').mockResolvedValue(undefined);
        vi.spyOn(PersistentTargetLock.prototype, 'release').mockResolvedValue(undefined);
        vi.spyOn(ObsViewport, 'measure').mockResolvedValue({
            x: 0,
            y: 80,
            width: 960,
            height: 640,
        });
        vi.spyOn(CommandRunner, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
        call.mockImplementation(async (request: string, data: Record<string, unknown> = {}) => {
            switch (request) {
                case 'GetRecordStatus':
                    return {
                        outputActive: active,
                        outputBytes: active ? 1024 : 0,
                        outputDuration: active ? 100 : 0,
                    };
                case 'GetStreamStatus':
                case 'GetVirtualCamStatus':
                    return { outputActive: false };
                case 'GetReplayBufferStatus':
                    throw Object.assign(new Error('Disabled'), { code: 604 });
                case 'GetProfileList':
                    return {
                        currentProfileName: 'Personal',
                        profiles: ['Personal', 'Browser Testbench'],
                    };
                case 'GetSceneCollectionList':
                    return {
                        currentSceneCollectionName: 'Personal',
                        sceneCollections: ['Personal', 'Browser Testbench'],
                    };
                case 'GetSceneList':
                    return { scenes: [{ sceneName: 'Recording' }] };
                case 'GetSpecialInputs':
                    return {};
                case 'GetInputKindList':
                    return { inputKinds: ['screen_capture', 'window_capture', 'xcomposite_input'] };
                case 'GetInputList':
                    return { inputs: [...inputs.values()] };
                case 'CreateInput': {
                    const inputName = String(data.inputName);

                    if (inputs.has(inputName)) {
                        throw new Error('A source already exists by that input name.');
                    }

                    const item = { inputName, sourceName: inputName, sceneItemId: inputs.size + 1 };
                    inputs.set(inputName, item);
                    return item;
                }
                case 'GetSceneItemList':
                    return { sceneItems: [...inputs.values()] };
                case 'GetInputPropertiesListPropertyItems':
                    return {
                        propertyItems: [{ itemName: title, itemValue: 1, itemEnabled: true }],
                    };
                case 'GetSceneItemTransform':
                    return { sceneItemTransform: { sourceWidth: 960, sourceHeight: 720 } };
                case 'SetRecordDirectory':
                    directories.push(String(data.recordDirectory));
                    break;
                case 'StartRecord':
                    active = true;
                    break;
            }

            return {};
        });
    });

    afterEach(async () => {
        await Promise.all(
            directories
                .splice(0)
                .map((directory) => rm(directory, { recursive: true, force: true })),
        );
        vi.restoreAllMocks();
    });

    it('reloads persisted output settings before starting and restores the personal setup', async () => {
        const recorder = await ObsRecorder.start(
            { name: 'chrome' },
            browser,
            '/tmp/output.mp4',
            geometry,
            'viewport',
        );
        const startIndex = call.mock.calls.findIndex(([request]) => request === 'StartRecord');
        expect(call.mock.calls.slice(startIndex - 2, startIndex)).toEqual([
            ['SetCurrentProfile', { profileName: 'Personal' }],
            ['SetCurrentProfile', { profileName: 'Browser Testbench' }],
        ]);
        expect(title).toBe('Application');
        expect(recorder.startedAtMonotonicMs).toBe(1234);
        await recorder.stop();
        expect(call.mock.calls.slice(-2)).toEqual([
            ['SetCurrentSceneCollection', { sceneCollectionName: 'Personal' }],
            ['SetCurrentProfile', { profileName: 'Personal' }],
        ]);
        expect(close).toHaveBeenCalledOnce();
        expect(PersistentTargetLock.prototype.release).toHaveBeenCalledOnce();
    });

    it('reuses the same two sources on subsequent recordings without deleting them', async () => {
        for (let index = 0; index < 2; index++) {
            const recorder = await ObsRecorder.start(
                { name: 'chrome' },
                browser,
                '/tmp/output.mp4',
                geometry,
                'viewport',
            );
            await recorder.stop();
        }

        expect(call.mock.calls.filter(([request]) => request === 'CreateInput')).toHaveLength(2);
        expect(
            call.mock.calls.filter(
                ([request]) => request === 'RemoveInput' || request === 'RemoveSceneItem',
            ),
        ).toHaveLength(0);
    });

    it('does not touch an OBS setup that is already recording', async () => {
        active = true;
        await expect(
            ObsRecorder.start({ name: 'chrome' }, browser, '/tmp/output.mp4', geometry, 'viewport'),
        ).rejects.toThrow('OBS is busy');
        expect(call.mock.calls.some(([request]) => request === 'SetCurrentProfile')).toBe(false);
        expect(stopRecording).not.toHaveBeenCalled();
        expect(PersistentTargetLock.prototype.release).toHaveBeenCalledOnce();
    });

    it('restores the personal workspace and releases OBS when viewport preparation fails', async () => {
        const failure = new Error('Viewport measurement failed');
        vi.mocked(ObsViewport.measure).mockRejectedValue(failure);
        await expect(
            ObsRecorder.start({ name: 'chrome' }, browser, '/tmp/output.mp4', geometry, 'viewport'),
        ).rejects.toBe(failure);
        expect(call.mock.calls.some(([request]) => request === 'StartRecord')).toBe(false);
        expect(stopRecording).not.toHaveBeenCalled();
        expect(call.mock.calls.slice(-2)).toEqual([
            ['SetCurrentSceneCollection', { sceneCollectionName: 'Personal' }],
            ['SetCurrentProfile', { profileName: 'Personal' }],
        ]);
        expect(close).toHaveBeenCalledOnce();
        expect(PersistentTargetLock.prototype.release).toHaveBeenCalledOnce();
    });

    it('keeps a session-owned USB source active between recordings', async () => {
        const workspace = await ObsWorkspace.open();
        const prepare = vi.spyOn(ObsCapture.prototype, 'prepare');
        call.mockClear();

        for (let index = 0; index < 2; index++) {
            const recorder = await ObsRecorder.start(
                { name: 'safari-ios', deviceKind: 'physical' },
                browser,
                '/tmp/output.mp4',
                geometry,
                'viewport',
                { workspace, source: 'iPhone', sceneItemId: 1 },
            );
            await recorder.stop();
        }

        expect(prepare).not.toHaveBeenCalled();
        expect(call.mock.calls.some(([request]) => request === 'SetCurrentSceneCollection')).toBe(
            false,
        );
        expect(close).not.toHaveBeenCalled();
        expect(PersistentTargetLock.prototype.release).not.toHaveBeenCalled();
        await workspace.close();
        expect(close).toHaveBeenCalledOnce();
        expect(PersistentTargetLock.prototype.release).toHaveBeenCalledOnce();
    });

    it('reloads saved audio offsets before the first recorded frame', async () => {
        const recorder = await ObsRecorder.start(
            { name: 'chrome' },
            browser,
            '/tmp/output.mp4',
            geometry,
            'viewport',
        );
        const offsetIndex = call.mock.calls.findIndex(
            ([request]) => request === 'SetInputAudioSyncOffset',
        );
        expect(call.mock.calls[offsetIndex]).toEqual([
            'SetInputAudioSyncOffset',
            { inputName: 'Testbench System Audio', inputAudioSyncOffset: 90 },
        ]);
        const firstActivation = call.mock.calls.findIndex(
            ([request, data]) => request === 'SetSceneItemEnabled' && data.sceneItemEnabled,
        );
        expect(firstActivation).toBeGreaterThan(offsetIndex);
        const afterOffset = call.mock.calls.slice(offsetIndex + 1);
        const reloadIndex = afterOffset.findIndex(
            ([request, data]) =>
                request === 'SetCurrentSceneCollection' &&
                data.sceneCollectionName === 'Browser Testbench',
        );
        const startIndex = afterOffset.findIndex(([request]) => request === 'StartRecord');
        expect(reloadIndex).toBeGreaterThanOrEqual(0);
        expect(startIndex).toBeGreaterThan(reloadIndex);
        await recorder.stop();
    });

    it('selects Android emulator windows by AVD name without requiring an iOS device name', async () => {
        title = 'Android Emulator - pixel8a-37.1:5554';
        const recorder = await ObsRecorder.start(
            { name: 'chrome-android', avd: 'pixel8a-37.1' },
            browser,
            '/tmp/output.mp4',
            geometry,
            'viewport',
        );
        expect(call).toHaveBeenCalledWith('SetInputSettings', {
            inputName: 'Testbench Window',
            inputSettings: { [process.platform === 'linux' ? 'capture_window' : 'window']: 1 },
        });
        expect(title).toBe('Android Emulator - pixel8a-37.1:5554');
        await recorder.stop();
    });

    it('retains the original recording if remuxing fails', async () => {
        const recorder = await ObsRecorder.start(
            { name: 'chrome' },
            browser,
            '/tmp/output.mp4',
            geometry,
            'viewport',
        );
        const original = join(directories.at(-1)!, 'source.mkv');
        await writeFile(original, 'recording');
        vi.mocked(CommandRunner.run).mockResolvedValue({
            code: 1,
            stdout: '',
            stderr: 'disk full',
        });
        await expect(recorder.stop()).rejects.toThrow(`Original retained at ${original}`);
        expect((await stat(original)).size).toBeGreaterThan(0);
        expect(PersistentTargetLock.prototype.release).toHaveBeenCalledOnce();
    });
});
