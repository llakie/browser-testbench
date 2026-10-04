import sharp from 'sharp';
import { TestbenchError } from '../errors/testbench-error.js';
import { ImageDimensions, type PixelRect } from '../recording/geometry.js';

export type ScreenshotScope = 'screen' | 'viewport' | 'fullPage' | 'element';

export interface ScreenshotResult {
    base64: string;
    width: number;
    height: number;
    scope: ScreenshotScope;
    screenBounds: PixelRect | null;
    viewportBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
        coordinateSystem: 'viewport-css-pixels';
        edges: 'left-top-inclusive-right-bottom-exclusive';
    } | null;
}

export class ScreenshotUtilities {
    static async withoutTransparentBottomRows(base64: string): Promise<string> {
        const { data, info } = await sharp(Buffer.from(base64, 'base64'))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        let height = info.height;

        while (height > 0) {
            const rowOffset = (height - 1) * info.width * info.channels;
            let transparent = true;

            for (
                let index = rowOffset + info.channels - 1;
                index < rowOffset + info.width * info.channels;
                index += info.channels
            ) {
                if (data[index] !== 0) {
                    transparent = false;
                    break;
                }
            }

            if (!transparent) {
                break;
            }

            height -= 1;
        }

        if (height === info.height) {
            return base64;
        }

        return sharp(data, {
            raw: { width: info.width, height: info.height, channels: info.channels },
        })
            .extract({ left: 0, top: 0, width: info.width, height })
            .png()
            .toBuffer()
            .then((image) => image.toString('base64'));
    }

    static result(
        base64: string,
        scope: ScreenshotScope,
        screenBounds: PixelRect | null,
        viewportBounds: ScreenshotResult['viewportBounds'],
    ): ScreenshotResult {
        return {
            base64,
            ...ImageDimensions.png(Buffer.from(base64, 'base64')),
            scope,
            screenBounds,
            viewportBounds,
        };
    }

    static async crop(base64: string, bounds: PixelRect): Promise<string> {
        try {
            const cropped = await sharp(Buffer.from(base64, 'base64'))
                .extract({
                    left: bounds.x,
                    top: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                })
                .png()
                .toBuffer();
            return cropped.toString('base64');
        } catch (error) {
            throw new TestbenchError(
                'SCREENSHOT_SCOPE_UNSUPPORTED',
                'Viewport screenshot could not be cropped.',
                {
                    operation: 'screenshot.viewport',
                    status: 409,
                    details: {
                        bounds,
                        diagnostic: error instanceof Error ? error.message : String(error),
                    },
                    cause: error,
                },
            );
        }
    }
}
