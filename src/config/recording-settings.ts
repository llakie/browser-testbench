import { z } from 'zod';

export const recordingSettingsSchema = z.strictObject({
    audioSyncOffsetMs: z.number().int().min(-950).max(20_000).default(0),
    captureDeviceId: z.string().trim().min(1).max(512).optional(),
});

export type RecordingSettings = z.infer<typeof recordingSettingsSchema>;
