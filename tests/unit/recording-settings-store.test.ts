import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestbenchPaths } from '../../src/infrastructure/paths.js';
import { RecordingSettingsStore } from '../../src/setup/recording-settings-store.js';

describe('RecordingSettingsStore', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'testbench-recording-settings-'));
        vi.spyOn(TestbenchPaths, 'data').mockImplementation((...parts) =>
            join(directory, ...parts),
        );
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    it('defaults to no correction and keeps desktop browsers separate', async () => {
        expect(await RecordingSettingsStore.read({ name: 'chrome' })).toEqual({
            audioSyncOffsetMs: 0,
        });
        await RecordingSettingsStore.write({ name: 'chrome' }, { audioSyncOffsetMs: 90 });
        expect(await RecordingSettingsStore.read({ name: 'chrome' })).toEqual({
            audioSyncOffsetMs: 90,
        });
        expect(await RecordingSettingsStore.read({ name: 'firefox' })).toEqual({
            audioSyncOffsetMs: 0,
        });
    });

    it('keeps settings with the physical device, not its name or OS version', async () => {
        const target = { name: 'safari-ios' as const, udid: 'device-a', deviceName: 'Old name' };
        const settings = { audioSyncOffsetMs: 90, captureDeviceId: 'obs-usb-device' };
        await RecordingSettingsStore.write(target, settings);
        expect(
            await RecordingSettingsStore.read({
                ...target,
                deviceName: 'New name',
                platformVersion: '99',
            }),
        ).toEqual(settings);
        expect(await RecordingSettingsStore.read({ ...target, udid: 'device-b' })).toEqual({
            audioSyncOffsetMs: 0,
        });
    });

    it('keeps emulator calibration across startup and changing runtime serials', async () => {
        const target = { name: 'chrome-android' as const, avd: 'pixel8a-37.1' };
        const settings = { audioSyncOffsetMs: -360 };
        await RecordingSettingsStore.write({ ...target, udid: 'emulator-5554' }, settings);
        expect(await RecordingSettingsStore.read(target)).toEqual(settings);
        expect(await RecordingSettingsStore.read({ ...target, udid: 'emulator-5556' })).toEqual(
            settings,
        );
        expect(
            await RecordingSettingsStore.read({
                ...target,
                avd: 'another-emulator',
                udid: 'emulator-5554',
            }),
        ).toEqual({ audioSyncOffsetMs: 0 });
    });

    it('rejects invalid values instead of saving an unusable configuration', async () => {
        for (const audioSyncOffsetMs of [-951, 20_001, 0.5, NaN]) {
            await expect(
                RecordingSettingsStore.write({ name: 'chrome' }, { audioSyncOffsetMs }),
            ).rejects.toThrow();
        }
    });

    it('does not silently discard a damaged configuration', async () => {
        vi.mocked(TestbenchPaths.data).mockReturnValue(join(directory, 'broken.json'));
        await writeFile(join(directory, 'broken.json'), 'not json');
        await expect(RecordingSettingsStore.read({ name: 'chrome' })).rejects.toThrow();
    });
});
