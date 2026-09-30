import { ObsWorkspace } from './obs-workspace.js';
import { LocalizedError } from '../i18n/translator.js';

export const IOS_CAPTURE_SOURCE = 'Testbench iPhone USB';

export class ObsIosCapture {
    static async devices(workspace: ObsWorkspace): Promise<Array<{ id: string; label: string }>> {
        if (process.platform !== 'darwin') {
            throw new LocalizedError({ key: 'recording.errors.iosPlatform' }, 409);
        }

        await workspace.input(IOS_CAPTURE_SOURCE, 'macos-avcapture', {
            device: '',
            enable_audio: true,
            use_preset: true,
            preset: 'AVCaptureSessionPresetHigh',
        });
        const { propertyItems } = await workspace.obs.call('GetInputPropertiesListPropertyItems', {
            inputName: IOS_CAPTURE_SOURCE,
            propertyName: 'device',
        });
        return propertyItems
            .filter((item) => item.itemEnabled && item.itemValue)
            .map((item) => ({ id: String(item.itemValue), label: String(item.itemName) }));
    }

    static async discover(): Promise<Array<{ id: string; label: string }>> {
        const workspace = await ObsWorkspace.open();

        try {
            return await this.devices(workspace);
        } finally {
            await workspace.close();
        }
    }

    static async prepare(workspace: ObsWorkspace, deviceId?: string): Promise<number> {
        if (!deviceId) {
            throw new LocalizedError({ key: 'recording.errors.selectDevice' }, 409);
        }

        const devices = await this.devices(workspace);

        if (!devices.some((device) => device.id === deviceId)) {
            throw new LocalizedError({ key: 'recording.errors.deviceUnavailable' }, 409);
        }

        return workspace.input(IOS_CAPTURE_SOURCE, 'macos-avcapture', {
            device: deviceId,
            enable_audio: true,
            use_preset: true,
            preset: 'AVCaptureSessionPresetHigh',
        });
    }
}
