import { defineComponent, useId } from 'vue';
import type { RecordingSettings as Settings } from '../../../config/recording-settings.js';
import { ApiClient } from '../core/api-client.js';
import { translator } from '../core/translator.js';
import { workbenchStore } from '../stores/workbench-store.js';

export const RecordingSettings = defineComponent({
    template: '#recording-settings-template',
    props: {
        targetId: { type: String, required: true },
        label: { type: String, required: true },
        usbCapture: Boolean,
        ghost: Boolean,
    },
    setup: () => ({ titleId: useId(), hintId: useId(), sourceId: useId() }),
    data: () => ({
        store: workbenchStore,
        loading: false,
        loaded: false,
        saving: false,
        error: '',
        settings: { audioSyncOffsetMs: 0 } as Settings,
        devices: [] as Array<{ id: string; label: string }>,
    }),
    methods: {
        t: translator.t.bind(translator),
        dialog(): HTMLDialogElement {
            return this.$refs.dialog as HTMLDialogElement;
        },
        async open(): Promise<void> {
            this.error = '';
            this.loading = true;
            this.loaded = false;
            this.dialog().showModal();

            try {
                this.settings = await ApiClient.request<Settings>(this.path());
                this.loaded = true;
            } catch (error) {
                this.error = this.store.message(error);
            } finally {
                this.loading = false;
            }
        },
        async discoverDevices(): Promise<void> {
            this.loading = true;
            this.error = '';

            try {
                this.devices = await ApiClient.request('/v1/recording/ios-devices', {
                    method: 'POST',
                });
            } catch (error) {
                this.error = this.store.message(error);
            } finally {
                this.loading = false;
            }
        },
        async save(): Promise<void> {
            this.saving = true;
            this.error = '';

            try {
                await ApiClient.request(this.path(), {
                    method: 'PUT',
                    body: JSON.stringify({
                        audioSyncOffsetMs: this.settings.audioSyncOffsetMs,
                        ...(this.settings.captureDeviceId
                            ? { captureDeviceId: this.settings.captureDeviceId }
                            : {}),
                    }),
                });
                this.store.setNotice(translator.t('recording.saved'), 'success');
                this.dialog().close();
            } catch (error) {
                this.error = this.store.message(error);
            } finally {
                this.saving = false;
            }
        },
        backdrop(event: MouseEvent): void {
            if (event.target === this.dialog()) {
                const bounds = this.dialog().getBoundingClientRect();

                if (
                    event.clientX < bounds.left ||
                    event.clientX > bounds.right ||
                    event.clientY < bounds.top ||
                    event.clientY > bounds.bottom
                ) {
                    this.dialog().close();
                }
            }
        },
        path(): string {
            return `/v1/targets/${encodeURIComponent(this.targetId)}/recording`;
        },
    },
});
