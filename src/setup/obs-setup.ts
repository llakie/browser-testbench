import type { DoctorCheck } from '../config/types.js';
import { ObsConnection } from '../recording/obs-connection.js';

export class ObsSetup {
    static async inspect(): Promise<DoctorCheck> {
        let connection: ObsConnection | undefined;

        try {
            connection = await ObsConnection.connect(750);
            await connection.call('GetVersion');
            return {
                id: 'obs',
                label: 'OBS Studio',
                status: 'ready',
                detail: { key: 'environment.obsReady' },
            };
        } catch {
            const command =
                process.platform === 'darwin'
                    ? 'brew install --cask obs'
                    : process.platform === 'win32'
                      ? 'winget install --id OBSProject.OBSStudio --exact'
                      : 'flatpak install flathub com.obsproject.Studio';
            return {
                id: 'obs',
                label: 'OBS Studio',
                status: 'action',
                detail: { key: 'environment.obsMissing' },
                action: { key: 'environment.obsSetup' },
                commands: [command],
            };
        } finally {
            await connection?.close();
        }
    }
}
