import { randomUUID } from 'node:crypto';
import { ObsConnection } from '../infrastructure/obs-connection.js';
import { PersistentTargetLock } from './target-lock-manager.js';
import { LocalizedError } from '../i18n/translator.js';

export const OBS_PROFILE = 'Browser Testbench';
export const OBS_SCENE = 'Recording';

/** Owns the exclusive OBS session and restores the user's workspace on every exit. */
export class ObsWorkspace {
    readonly id = randomUUID();
    private readonly locks = new PersistentTargetLock();
    private connection?: ObsConnection;
    private profile?: string;
    private collection?: string;
    private otherProfile?: string;
    private otherCollection?: string;

    get obs(): ObsConnection {
        if (!this.connection) {
            throw new Error('OBS workspace is not connected.');
        }

        return this.connection;
    }

    static async open(): Promise<ObsWorkspace> {
        const workspace = new ObsWorkspace();
        await workspace.locks.acquire('obs-recording', 'recording', workspace.id, 0);

        try {
            workspace.connection = await ObsConnection.connect();
            await workspace.prepare();
            return workspace;
        } catch (error) {
            await workspace.close();
            throw error;
        }
    }

    private async prepare(): Promise<void> {
        const obs = this.obs;
        const states = await Promise.all([
            obs.call('GetRecordStatus'),
            obs.call('GetStreamStatus'),
            obs.call('GetVirtualCamStatus'),
            obs.call('GetReplayBufferStatus').catch((error) => {
                if (error.code === 604) {
                    return { outputActive: false };
                }

                throw error;
            }),
        ]);

        if (states.some((state) => state.outputActive)) {
            throw new LocalizedError({ key: 'recording.errors.busy' }, 409);
        }

        const profiles = await obs.call('GetProfileList');
        const collections = await obs.call('GetSceneCollectionList');
        this.profile = profiles.currentProfileName;
        this.collection = collections.currentSceneCollectionName;
        this.otherProfile = profiles.profiles.find((name) => name !== OBS_PROFILE);
        this.otherCollection = collections.sceneCollections.find((name) => name !== OBS_PROFILE);

        if (!this.otherProfile || !this.otherCollection) {
            throw new LocalizedError({ key: 'recording.errors.personalWorkspace' }, 409);
        }

        await obs.call(
            profiles.profiles.includes(OBS_PROFILE) ? 'SetCurrentProfile' : 'CreateProfile',
            { profileName: OBS_PROFILE },
        );
        await obs.call(
            collections.sceneCollections.includes(OBS_PROFILE)
                ? 'SetCurrentSceneCollection'
                : 'CreateSceneCollection',
            { sceneCollectionName: OBS_PROFILE },
        );
        const { scenes } = await obs.call('GetSceneList');

        if (!scenes.some((scene) => scene.sceneName === OBS_SCENE)) {
            await obs.call('CreateScene', { sceneName: OBS_SCENE });
        }

        for (const inputName of Object.values(await obs.call('GetSpecialInputs'))) {
            if (inputName) {
                await obs.call('SetInputMute', { inputName, inputMuted: true });
            }
        }

        // Previous capture routes must never contribute a second picture or audio stream.
        const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: OBS_SCENE });

        for (const item of sceneItems) {
            await obs.call('SetSceneItemEnabled', {
                sceneName: OBS_SCENE,
                sceneItemId: Number(item.sceneItemId),
                sceneItemEnabled: false,
            });
        }

        await obs.call('SetCurrentProgramScene', { sceneName: OBS_SCENE });
    }

    async input(
        name: string,
        kind: string,
        settings: Record<string, string | number | boolean>,
    ): Promise<number> {
        const { inputs } = await this.obs.call('GetInputList');
        const existing = inputs.find((input) => input.inputName === name);

        if (!existing) {
            const result = await this.obs.call('CreateInput', {
                sceneName: OBS_SCENE,
                inputName: name,
                inputKind: kind,
                inputSettings: settings,
                sceneItemEnabled: false,
            });
            return result.sceneItemId;
        }

        await this.obs.call('SetInputSettings', { inputName: name, inputSettings: settings });
        const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: OBS_SCENE });
        const item = sceneItems.find((candidate) => candidate.sourceName === name);

        if (item) {
            return Number(item.sceneItemId);
        }

        return (
            await this.obs.call('CreateSceneItem', {
                sceneName: OBS_SCENE,
                sourceName: name,
                sceneItemEnabled: false,
            })
        ).sceneItemId;
    }

    async enable(sceneItemId: number): Promise<void> {
        await this.obs.call('SetSceneItemEnabled', {
            sceneName: OBS_SCENE,
            sceneItemId,
            sceneItemEnabled: true,
        });
    }

    async reloadSources(): Promise<void> {
        // OBS 32 can ignore the first live change from a zero audio offset. Loading the
        // saved collection applies the offset before the first audio packet instead.
        await this.obs.call('SetCurrentSceneCollection', {
            sceneCollectionName: this.otherCollection!,
        });
        await this.obs.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_PROFILE });
    }

    async reloadProfile(): Promise<void> {
        // Rebuild OBS output handlers after persisting encoder/recording settings.
        await this.obs.call('SetCurrentProfile', { profileName: this.otherProfile! });
        await this.obs.call('SetCurrentProfile', { profileName: OBS_PROFILE });
    }

    async close(): Promise<void> {
        try {
            try {
                if (this.collection) {
                    await this.obs.call('SetCurrentSceneCollection', {
                        sceneCollectionName: this.collection,
                    });
                }
            } finally {
                if (this.profile) {
                    await this.obs.call('SetCurrentProfile', { profileName: this.profile });
                }
            }
        } finally {
            try {
                await this.connection?.close();
            } finally {
                await this.locks.release('obs-recording', this.id);
            }
        }
    }
}
