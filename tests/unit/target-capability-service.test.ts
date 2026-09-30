import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TargetCapabilityService } from '../../src/setup/target-capability-service.js';
import { MediaTooling } from '../../src/infrastructure/media-tooling.js';

describe('TargetCapabilityService', () => {
    beforeEach(() => vi.spyOn(MediaTooling, 'isAvailable').mockReturnValue(true));

    const android = () =>
        TargetCapabilityService.for({
            browser: 'chrome-android',
            kind: 'mobile',
            deviceKind: 'emulator',
        });

    it('describes target features and server limits without starting a target', () => {
        expect(android()).toMatchObject({
            localOrigins: { reverse: true },
            permissions: { native: ['camera', 'microphone'] },
            mediaInjection: { cameraImage: true },
            mediaPlayback: { autoplay: true },
            recording: { screen: true, marks: true },
            screenshots: { viewport: true, element: true },
        });
        expect(android().limits.assetBytes).toBeGreaterThanOrEqual(25 * 1024 * 1024);
    });

    it('advertises automated audio playback only where the browser can be configured for it', () => {
        for (const browser of ['chrome', 'edge', 'firefox', 'chrome-android'] as const) {
            expect(
                TargetCapabilityService.for({
                    browser,
                    kind: browser === 'chrome-android' ? 'mobile' : 'desktop',
                }),
            ).toMatchObject({
                mediaPlayback: { autoplay: true },
            });
        }

        for (const browser of ['safari', 'safari-ios'] as const) {
            expect(
                TargetCapabilityService.for({
                    browser,
                    kind: browser === 'safari-ios' ? 'mobile' : 'desktop',
                }),
            ).toMatchObject({
                mediaPlayback: { autoplay: false },
            });
        }
    });

    it('advertises iPhone USB recording only on macOS', () => {
        const physical = TargetCapabilityService.for({
            browser: 'safari-ios',
            kind: 'mobile',
            deviceKind: 'physical',
        });
        const simulator = TargetCapabilityService.for({
            browser: 'safari-ios',
            kind: 'mobile',
            deviceKind: 'simulator',
        });

        expect(physical.recording).toMatchObject({
            screen: process.platform === 'darwin',
            viewport: process.platform === 'darwin',
            explicitLifecycle: process.platform === 'darwin',
        });
        expect(simulator.recording.screen).toBe(process.platform === 'darwin');
    });

    it('advertises viewport recording for supported desktop browsers', () => {
        for (const browser of ['chrome', 'edge', 'firefox'] as const) {
            expect(TargetCapabilityService.for({ browser, kind: 'desktop' })).toMatchObject({
                recording: {
                    screen: false,
                    viewport: true,
                    explicitLifecycle: true,
                    geometry: true,
                },
            });
        }
    });

    it('keeps all screenshot scopes available without FFmpeg', () => {
        vi.mocked(MediaTooling.isAvailable).mockReturnValue(false);

        expect(android()).toMatchObject({
            recording: { screen: false, viewport: false },
            screenshots: { screen: true, viewport: true, element: true },
        });
        expect(TargetCapabilityService.for({ browser: 'chrome', kind: 'desktop' })).toMatchObject({
            recording: { screen: false, viewport: false },
            screenshots: { viewport: true, fullPage: true },
        });
    });

    it('reports every missing nested capability', () => {
        expect(
            TargetCapabilityService.missing(
                {
                    recording: { viewport: true, pauseResume: true },
                    permissions: { native: ['camera', 'notifications'] },
                },
                android(),
            ),
        ).toEqual(['recording.pauseResume', 'permissions.native']);
    });
});
