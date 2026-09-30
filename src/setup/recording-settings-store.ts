import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { recordingSettingsSchema, type RecordingSettings } from '../config/recording-settings.js';
import type { TargetConfig } from '../config/types.js';
import { TestbenchPaths } from '../infrastructure/paths.js';

export class RecordingSettingsStore {
    static async read(target: TargetConfig): Promise<RecordingSettings> {
        try {
            return recordingSettingsSchema.parse(
                JSON.parse(await readFile(this.path(target), 'utf8')),
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return recordingSettingsSchema.parse({});
            }

            throw error;
        }
    }

    static async write(target: TargetConfig, input: RecordingSettings): Promise<RecordingSettings> {
        const settings = recordingSettingsSchema.parse(input);
        const path = this.path(target);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });

        try {
            await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }

        return settings;
    }

    private static path(target: TargetConfig): string {
        // AVD names stay stable when Android assigns a different emulator serial on startup.
        // Physical devices keep their calibration across OS upgrades and display-name changes.
        const identity = [target.name, target.avd ?? target.udid ?? target.deviceName ?? 'desktop'];
        const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        return TestbenchPaths.data('recording', `${key}.json`);
    }
}
