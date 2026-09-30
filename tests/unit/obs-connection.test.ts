import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObsConnection } from '../../src/recording/obs-connection.js';

const mocks = vi.hoisted(() => ({
    readFile: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    call: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('node:os', () => ({ homedir: () => '/test-home' }));
vi.mock('obs-websocket-js', () => ({
    OBSWebSocket: class {
        connect = mocks.connect;
        disconnect = mocks.disconnect;
        call = mocks.call;
        on = mocks.on;
        off = mocks.off;
    },
}));

describe('ObsConnection configuration', () => {
    beforeEach(() => {
        vi.stubGlobal('process', { ...process, platform: 'linux', env: {} });
        mocks.readFile.mockReset();
        mocks.connect.mockReset().mockResolvedValue({});
        mocks.disconnect.mockReset().mockResolvedValue(undefined);
        mocks.call.mockReset();
        mocks.on.mockReset();
        mocks.off.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        ['darwin', '/test-home/Library/Application Support'],
        ['win32', '/test-home/AppData/Roaming'],
        ['linux', '/test-home/.config'],
    ])('reads the native %s configuration', async (platform, root) => {
        vi.stubGlobal('process', { ...process, platform });
        mocks.readFile.mockResolvedValue(
            JSON.stringify({ server_port: 4456, server_password: 'test-password' }),
        );
        const connection = await ObsConnection.connect();
        expect(mocks.readFile).toHaveBeenCalledWith(
            join(root, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'),
            'utf8',
        );
        expect(mocks.connect).toHaveBeenCalledWith('ws://127.0.0.1:4456/', 'test-password');
        await connection.close();
    });

    it('reads credentials from the recommended Flatpak installation', async () => {
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.includes(join('.var', 'app', 'com.obsproject.Studio', 'config'))) {
                return JSON.stringify({ server_port: 4456, server_password: 'test-password' });
            }

            throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
        });
        const connection = await ObsConnection.connect();
        expect(mocks.connect).toHaveBeenCalledWith('ws://127.0.0.1:4456/', 'test-password');
        await connection.close();
    });

    it('does not hide damaged configuration files', async () => {
        mocks.readFile.mockResolvedValue('invalid json');
        await expect(ObsConnection.connect()).rejects.toThrow();
        expect(mocks.connect).not.toHaveBeenCalled();
    });

    it('keeps explicit OBS connections on this host', async () => {
        process.env.OBS_URL = 'ws://another-host:4455';
        mocks.readFile.mockRejectedValue(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
        await expect(ObsConnection.connect()).rejects.toThrow('Testbench host');
        expect(mocks.connect).not.toHaveBeenCalled();
    });

    it('anchors recording to the started event, before encoder readiness or the request response', async () => {
        mocks.readFile.mockResolvedValue('{}');
        const connection = await ObsConnection.connect();
        let eventTime = 0;
        mocks.call.mockImplementation(async () => {
            const listener = mocks.on.mock.calls[0]![1] as (event: { outputState: string }) => void;
            listener({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
            eventTime = performance.now();
            listener({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        const epoch = await connection.startRecording();
        expect(epoch).toBeGreaterThanOrEqual(eventTime);
        expect(epoch - eventTime).toBeLessThan(10);
        expect(performance.now() - epoch).toBeGreaterThanOrEqual(15);
        expect(mocks.call).toHaveBeenCalledWith('StartRecord', undefined);
        expect(mocks.off).toHaveBeenCalledWith('RecordStateChanged', mocks.on.mock.calls[0]![1]);
        await connection.close();
    });

    it('removes the recording event listener if starting fails', async () => {
        mocks.readFile.mockResolvedValue('{}');
        mocks.call.mockRejectedValue(new Error('Encoder unavailable'));
        const connection = await ObsConnection.connect();
        await expect(connection.startRecording()).rejects.toThrow('Encoder unavailable');
        expect(mocks.off).toHaveBeenCalledWith('RecordStateChanged', mocks.on.mock.calls[0]![1]);
        await connection.close();
    });

    it('stops an accepted recording if its start event never arrives', async () => {
        vi.useFakeTimers();
        mocks.readFile.mockResolvedValue('{}');
        mocks.call.mockResolvedValue({});
        const connection = await ObsConnection.connect();
        const stop = vi.spyOn(connection, 'stopRecording').mockResolvedValue('/tmp/partial.mkv');
        const failure = expect(connection.startRecording()).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(10_001);
        await failure;
        expect(stop).toHaveBeenCalledOnce();
        expect(mocks.off).toHaveBeenCalledWith('RecordStateChanged', mocks.on.mock.calls[0]![1]);
        await connection.close();
    });
});
