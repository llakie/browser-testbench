import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OBSWebSocket, type OBSRequestTypes, type OBSResponseTypes } from 'obs-websocket-js';
import { LocalizedError } from '../i18n/translator.js';

const REQUEST_TIMEOUT_MS = 10_000;

export class ObsConnection {
    private readonly socket = new OBSWebSocket();

    static async connect(timeoutMs = REQUEST_TIMEOUT_MS): Promise<ObsConnection> {
        const connection = new ObsConnection();
        const configuration = await this.configuration();
        const url = new URL(
            process.env.OBS_URL ?? `ws://127.0.0.1:${configuration.server_port ?? 4455}`,
        );

        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            throw new LocalizedError({ key: 'recording.errors.localObs' }, 409);
        }

        try {
            await connection.timeout(
                connection.socket.connect(
                    url.href,
                    process.env.OBS_PASSWORD ?? configuration.server_password,
                ),
                timeoutMs,
            );
            return connection;
        } catch {
            await connection.close();
            throw new LocalizedError({ key: 'recording.errors.notConnected' }, 409);
        }
    }

    private static async configuration(): Promise<{
        server_port?: number;
        server_password?: string;
    }> {
        const root =
            process.platform === 'darwin'
                ? join(homedir(), 'Library', 'Application Support')
                : process.platform === 'win32'
                  ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
                  : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
        const roots = [root];

        if (process.platform === 'linux') {
            roots.push(join(homedir(), '.var', 'app', 'com.obsproject.Studio', 'config'));
        }

        for (const directory of roots) {
            const path = join(
                directory,
                'obs-studio',
                'plugin_config',
                'obs-websocket',
                'config.json',
            );

            try {
                return JSON.parse(await readFile(path, 'utf8'));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }

        return {};
    }

    async call<K extends keyof OBSRequestTypes>(
        request: K,
        data?: OBSRequestTypes[K],
    ): Promise<OBSResponseTypes[K]> {
        try {
            return await this.timeout(this.socket.call(request, data), REQUEST_TIMEOUT_MS);
        } catch (error) {
            const detail = error as { code?: number; message?: string };
            throw Object.assign(
                new Error(`OBS ${request}: ${detail.message ?? String(error)}`, { cause: error }),
                {
                    code: detail.code,
                },
            );
        }
    }

    async close(): Promise<void> {
        await this.socket.disconnect();
    }

    async stopRecording(): Promise<string> {
        let finish: (event: { outputState: string }) => void = () => undefined;
        const stopped = new Promise<void>((resolve) => {
            finish = (event) => {
                if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
                    resolve();
                }
            };
            this.socket.on('RecordStateChanged', finish);
        });

        try {
            const { outputPath } = await this.call('StopRecord');
            await this.timeout(stopped, 60_000);
            return outputPath;
        } finally {
            this.socket.off('RecordStateChanged', finish);
        }
    }

    async startRecording(): Promise<number> {
        let started: (event: { outputState: string }) => void = () => undefined;
        const epoch = new Promise<number>((resolve) => {
            started = (event) => {
                if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
                    resolve(performance.now());
                }
            };
            this.socket.on('RecordStateChanged', started);
        });

        try {
            await this.call('StartRecord');

            try {
                return await this.timeout(epoch, REQUEST_TIMEOUT_MS);
            } catch (error) {
                await this.stopRecording();
                throw error;
            }
        } finally {
            this.socket.off('RecordStateChanged', started);
        }
    }

    private async timeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
        let timer: NodeJS.Timeout | undefined;

        try {
            return await Promise.race([
                work,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('OBS request timed out.')),
                        milliseconds,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
}
