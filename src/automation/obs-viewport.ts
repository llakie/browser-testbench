import sharp from 'sharp';
import type { ObsConnection } from '../infrastructure/obs-connection.js';
import type { BrowserHandle } from './browser-session.js';
import { OperationWait } from './operation-wait.js';

const MARKER_INSET = 8;

export interface ObsBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

// A temporary inset marker identifies the viewport independently of browser chrome,
// simulator bezels, host scaling and device DPR. Black edges prevent Safari from
// extending the marker color into its translucent browser bars.
export class ObsViewport {
    static async measure(
        obs: ObsConnection,
        browser: BrowserHandle,
        source: string,
        token: string,
    ): Promise<ObsBounds> {
        const viewport = await browser.execute<{ width: number; height: number }>(
            `
            const marker = document.createElement('div');
            marker.id = arguments[0];
            marker.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;background:black!important;pointer-events:none!important;';
            const inner = document.createElement('div');
            inner.style.cssText = 'position:absolute!important;inset:' + arguments[1] + 'px!important;background:rgb(1,254,127)!important;';
            marker.append(inner);
            document.documentElement.append(marker);
            const { width, height } = marker.getBoundingClientRect();
            return { width, height };
        `,
            token,
            MARKER_INSET,
        );
        let bounds: ObsBounds | undefined;

        try {
            await OperationWait.until(
                async () => {
                    bounds = await this.detect(await this.screenshot(obs, source));
                    return Boolean(bounds);
                },
                { operation: 'recording.viewport', timeoutMs: 10_000 },
            );
        } finally {
            await browser.execute('document.getElementById(arguments[0])?.remove();', token);
        }

        await OperationWait.until(
            async () => !(await this.detect(await this.screenshot(obs, source))),
            {
                operation: 'recording.viewport.clear',
                timeoutMs: 10_000,
            },
        );
        const insetX = (bounds!.width * MARKER_INSET) / (viewport.width - 2 * MARKER_INSET);
        const insetY = (bounds!.height * MARKER_INSET) / (viewport.height - 2 * MARKER_INSET);
        return {
            x: bounds!.x - insetX,
            y: bounds!.y - insetY,
            width: bounds!.width + 2 * insetX,
            height: bounds!.height + 2 * insetY,
        };
    }

    private static async screenshot(obs: ObsConnection, sourceName: string): Promise<Buffer> {
        const { imageData } = await obs.call('GetSourceScreenshot', {
            sourceName,
            imageFormat: 'png',
        });
        return Buffer.from(imageData.slice(imageData.indexOf(',') + 1), 'base64');
    }

    static async detect(image: Buffer): Promise<ObsBounds | undefined> {
        const { data, info } = await sharp(image)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        let left = info.width;
        let top = info.height;
        let right = -1;
        let bottom = -1;
        let matches = 0;

        for (let y = 0; y < info.height; y++) {
            for (let x = 0; x < info.width; x++) {
                const offset = (y * info.width + x) * info.channels;

                if (
                    data[offset]! < 35 &&
                    data[offset + 1]! > 220 &&
                    Math.abs(data[offset + 2]! - 127) < 35
                ) {
                    left = Math.min(left, x);
                    right = Math.max(right, x);
                    top = Math.min(top, y);
                    bottom = Math.max(bottom, y);
                    matches++;
                }
            }
        }

        const width = right - left + 1;
        const height = bottom - top + 1;

        if (width < 100 || height < 100 || matches < width * height * 0.98) {
            return undefined;
        }

        return { x: left, y: top, width, height };
    }
}
