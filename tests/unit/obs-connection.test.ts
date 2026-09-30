import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObsConnection } from '../../src/infrastructure/obs-connection.js';

const mocks = vi.hoisted(() => ({
    readFile: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('node:os', () => ({ homedir: () => '/test-home' }));
vi.mock('obs-websocket-js', () => ({
    OBSWebSocket: class {
        connect = mocks.connect;
        disconnect = mocks.disconnect;
    },
}));

describe('ObsConnection configuration', () => {
    beforeEach(() => {
        vi.stubGlobal('process', { ...process, platform: 'linux', env: {} });
        mocks.readFile.mockReset();
        mocks.connect.mockReset().mockResolvedValue({});
        mocks.disconnect.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => vi.unstubAllGlobals());

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
});
