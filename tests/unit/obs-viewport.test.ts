import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserHandle } from '../../src/automation/browser-session.js';
import { ObsViewport } from '../../src/automation/obs-viewport.js';
import { OperationWait } from '../../src/automation/operation-wait.js';
import type { ObsConnection } from '../../src/infrastructure/obs-connection.js';

const marker = { r: 1, g: 254, b: 127 };

async function rectangle(width: number, height: number, background = marker): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 4, background } })
        .png()
        .toBuffer();
}

describe('ObsViewport', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('finds the complete viewport independently of the surrounding window and alpha channel', async () => {
        const image = await sharp(await rectangle(500, 700, { r: 0, g: 0, b: 0 }))
            .composite([{ input: await rectangle(320, 480), left: 70, top: 120 }])
            .png()
            .toBuffer();
        expect(await ObsViewport.detect(image)).toEqual({
            x: 70,
            y: 120,
            width: 320,
            height: 480,
        });
    });

    it('rejects missing markers, small green controls and disconnected green regions', async () => {
        expect(
            await ObsViewport.detect(await rectangle(320, 480, { r: 0, g: 0, b: 0 })),
        ).toBeUndefined();
        expect(await ObsViewport.detect(await rectangle(99, 200))).toBeUndefined();
        const separated = await sharp(await rectangle(400, 400, { r: 0, g: 0, b: 0 }))
            .composite([
                { input: await rectangle(100, 100), left: 0, top: 0 },
                { input: await rectangle(100, 100), left: 300, top: 300 },
            ])
            .png()
            .toBuffer();
        expect(await ObsViewport.detect(separated)).toBeUndefined();
    });

    it.each([1, 2])(
        'restores the inset at %ix scale and waits for the marker to clear',
        async (scale) => {
            const green = await rectangle(320 * scale, 480 * scale);
            const cleared = await rectangle(320, 480, { r: 0, g: 0, b: 0 });
            const call = vi
                .fn()
                .mockResolvedValueOnce({
                    imageData: `data:image/png;base64,${green.toString('base64')}`,
                })
                .mockResolvedValueOnce({
                    imageData: `data:image/png;base64,${cleared.toString('base64')}`,
                });
            const execute = vi.fn().mockResolvedValue({ width: 336, height: 496 });
            expect(
                await ObsViewport.measure(
                    { call } as unknown as ObsConnection,
                    { execute } as unknown as BrowserHandle,
                    'Browser',
                    'marker-id',
                ),
            ).toEqual({ x: -8 * scale, y: -8 * scale, width: 336 * scale, height: 496 * scale });
            expect(execute).toHaveBeenLastCalledWith(
                'document.getElementById(arguments[0])?.remove();',
                'marker-id',
            );
            expect(call).toHaveBeenCalledTimes(2);
            expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
                call.mock.invocationCallOrder[1]!,
            );
        },
    );

    it('removes the marker even when viewport detection times out', async () => {
        const failure = new Error('Viewport detection timed out');
        vi.spyOn(OperationWait, 'until').mockRejectedValue(failure);
        const execute = vi.fn();
        await expect(
            ObsViewport.measure(
                {} as ObsConnection,
                { execute } as unknown as BrowserHandle,
                'Browser',
                'marker-id',
            ),
        ).rejects.toBe(failure);
        expect(execute).toHaveBeenLastCalledWith(
            'document.getElementById(arguments[0])?.remove();',
            'marker-id',
        );
    });
});
