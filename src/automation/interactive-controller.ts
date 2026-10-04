import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { TestbenchDefaults } from '../config/defaults.js';
import {
    InputSchemas,
    type BrowserActionRequest,
    type ElementActionRequest,
    type StartSessionInput,
    type WaitRequest,
} from '../config/input-schemas.js';
import type { GestureRequest } from '../config/input-schemas.js';
import { TargetRegistry } from '../config/target-registry.js';
import type { TargetConfig, TargetName } from '../config/types.js';
import { ServiceManager, type ManagedProcess } from '../infrastructure/process-manager.js';
import { BrowserSession } from './browser-session.js';
import { BrowserDiagnostics, type DiagnosticEvent } from './browser-diagnostics.js';
import { AppiumSessionClient } from './appium-session-client.js';
import { IosPhysicalStartupError } from './ios-physical-startup-error.js';
import { IosPhysicalSafariNavigator } from './ios-physical-safari-navigator.js';
import { IosSessionCleanup } from './ios-session-cleanup.js';
import { MobileGestures, type GestureExecution } from './mobile-gestures.js';
import { PageInspectionScript } from './page-inspection-script.js';
import { VideoRecorder, type RecordingArtifact } from '../recording/video-recorder.js';
import { randomUUID } from 'node:crypto';
import { SessionPermissions } from './session-permissions.js';
import { AndroidBrowserUi } from './android-browser-ui.js';
import { TestbenchError } from '../errors/testbench-error.js';
import { ImageDimensions, RecordingGeometry, type GeometrySample } from '../recording/geometry.js';
import {
    ScreenshotUtilities,
    type ScreenshotResult,
    type ScreenshotScope,
} from './screenshot-utilities.js';
import { AbortableOperation } from './abortable-operation.js';
import { AndroidDeviceUtilities } from './android-device-utilities.js';
import { ObsCapture, type PreparedObsCapture } from '../recording/obs-capture.js';
import { LocalizedError } from '../i18n/translator.js';

export interface PageInspection {
    url: string;
    title: string;
    elements: Array<{
        tag: string;
        role?: string;
        type?: string;
        text?: string;
        label?: string;
        value?: string;
        selector: string;
        disabled: boolean;
        checked?: boolean;
    }>;
}

export type ResolvedStartSessionInput = Omit<StartSessionInput, 'target'> & {
    target: TargetName;
    targetId: string;
    deviceName?: string;
    platformVersion?: string;
    avd?: string;
    udid?: string;
    deviceKind?: TargetConfig['deviceKind'];
    iosTeamId?: string;
    iosSigningId?: string;
    wdaBundleId?: string;
};

class CleanupTimeoutError extends Error {}

export class InteractiveController {
    private readonly session = new BrowserSession();
    private appium?: { process: ManagedProcess; port: number };
    private target?: TargetConfig;
    private preparedCapture?: PreparedObsCapture;
    private video?: {
        id: string;
        recorder: VideoRecorder;
        path: string;
        scope: 'screen' | 'viewport';
        geometry: GeometrySample[];
        startedAtMs: number;
    };
    private lastRecording?: RecordingArtifact & {
        id: string;
        requestedScope: 'screen' | 'viewport';
        actualScope: 'screen' | 'viewport';
        geometry: { samples: GeometrySample[] };
    };
    private readonly browserDiagnostics = new BrowserDiagnostics();
    private readonly permissions = new SessionPermissions((path, body) =>
        this.appiumCommand(path, body),
    );
    private pendingBrowserClose?: Promise<void>;

    async start(options: ResolvedStartSessionInput): Promise<Record<string, unknown>> {
        if (!TargetRegistry.isSupported(options.target)) {
            throw new Error(`${options.target} is not supported on ${process.platform}.`);
        }

        await this.close();
        const target: TargetConfig = {
            name: options.target,
            headless: options.headless,
            deviceName: options.deviceName,
            platformVersion: options.platformVersion,
            avd: options.avd,
            udid: options.udid,
            deviceKind: options.deviceKind,
            iosTeamId: options.iosTeamId,
            iosSigningId: options.iosSigningId,
            wdaBundleId: options.wdaBundleId,
            initialUrl: TestbenchDefaults.IOS_SAFARI_BOOTSTRAP_URL,
            downloadDir: options.downloadDir,
            capabilities: options.capabilities,
            localOrigins: options.localOrigins,
        };
        const initialDeeplink = Boolean(
            options.url && IosPhysicalSafariNavigator.supportsInitialDeeplink(target),
        );

        if (!initialDeeplink) {
            target.initialUrl = undefined;
        }

        const attempts =
            target.name === 'safari-ios' && target.deviceKind === 'physical'
                ? TestbenchDefaults.IOS_SESSION_START_ATTEMPTS
                : 1;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            this.target = target;
            let browserStarted = false;

            try {
                const recording = options.require?.recording as
                    | { viewport?: boolean; screen?: boolean; explicitLifecycle?: boolean }
                    | undefined;

                if (
                    target.name === 'safari-ios' &&
                    target.deviceKind === 'physical' &&
                    (options.videoPath ||
                        recording?.viewport ||
                        recording?.screen ||
                        recording?.explicitLifecycle)
                ) {
                    // USB screen capture can reconnect the device. Initialize it before
                    // Appium establishes its Safari and XCTest connections.
                    this.preparedCapture = await ObsCapture.prepareIosSession(target);
                }

                if (TargetRegistry.definitions[options.target].kind === 'mobile') {
                    this.appium = await ServiceManager.startAppium();
                }

                const browser = await this.session.start(target, {
                    appiumPort: this.appium?.port,
                    targetId: options.targetId,
                });
                browserStarted = true;

                if (target.name === 'chrome-android') {
                    target.udid ??= AndroidDeviceUtilities.configuredSerial(
                        target,
                        browser.capabilities,
                    );
                    await this.session.navigate('about:blank');
                }

                const permissions = await this.permissions.prepare(
                    target,
                    browser,
                    options.permissions ?? [],
                );

                if (options.videoPath) {
                    await this.startRecording({ outputPath: options.videoPath, scope: 'screen' });
                }

                if (options.url) {
                    if (initialDeeplink) {
                        if (!this.appium) {
                            throw new Error(
                                'The Appium service for this iOS session is not available.',
                            );
                        }

                        await IosPhysicalSafariNavigator.navigate(
                            this.appium.port,
                            browser.sessionId,
                            options.url,
                            target,
                        );
                    } else {
                        await this.session.navigate(options.url);
                    }

                    const actualUrl = permissions.requested.length
                        ? await browser.getUrl()
                        : options.url;

                    if (
                        await this.permissions.grantRedirect(
                            target,
                            browser,
                            options.url,
                            actualUrl,
                        )
                    ) {
                        await this.session.navigate(actualUrl);
                    }
                }

                return {
                    target: options.targetId,
                    browser: options.target,
                    sessionId: browser.sessionId,
                    capabilities: browser.capabilities,
                    url: options.url,
                    ...(target.name === 'chrome-android' && options.url
                        ? {
                              localOrigin: {
                                  mode: target.localOrigins ?? 'reverse',
                                  requested: new URL(options.url).origin,
                                  actual: new URL(await this.session.active.getUrl()).origin,
                              },
                          }
                        : {}),
                    permissions,
                };
            } catch (error) {
                const appiumOutput = browserStarted
                    ? ''
                    : await this.iosStartupDiagnostic(target, error);
                const reportedError = IosPhysicalStartupError.from(error, target, appiumOutput);

                try {
                    await this.close();
                } catch (cleanupError) {
                    throw new AggregateError(
                        [reportedError, cleanupError],
                        'Browser session startup and cleanup failed.',
                    );
                }

                if (attempt < attempts && IosPhysicalStartupError.isSafariDebuggerTimeout(error)) {
                    continue;
                }

                throw reportedError;
            }
        }

        throw new Error('Browser session startup failed.');
    }

    async navigate(
        url: string,
        options: { timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<PageInspection> {
        if (!this.target) {
            throw new Error('No interactive target is active.');
        }

        if (this.target.name === 'safari-ios' && this.target.deviceKind === 'physical') {
            if (!this.appium) {
                throw new Error('The Appium service for this iOS session is not available.');
            }

            await AbortableOperation.run(
                IosPhysicalSafariNavigator.navigate(
                    this.appium.port,
                    this.session.active.sessionId,
                    url,
                    this.target,
                ),
                {
                    name: 'navigate',
                    timeoutMs: options.timeoutMs,
                    signal: options.signal,
                    details: { url },
                },
            );

            try {
                return await this.inspect();
            } catch (error) {
                if (IosPhysicalStartupError.isSafariDebuggerTimeout(error)) {
                    return { url, title: '', elements: [] };
                }

                throw error;
            }
        } else {
            await this.session.navigate(url, options);
        }

        return this.inspect();
    }

    async inspect(limit = TestbenchDefaults.INSPECTION_LIMIT): Promise<PageInspection> {
        const browser = this.session.active;
        const elements = await browser.execute<PageInspection['elements']>(
            PageInspectionScript.SOURCE,
            limit,
            TestbenchDefaults.INSPECTED_TEXT_MAX_LENGTH,
        );
        return {
            url: await browser.getUrl(),
            title: await browser.getTitle(),
            elements: elements as PageInspection['elements'],
        };
    }

    async click(selector: string): Promise<void> {
        const element = await this.session.active.$(selector);
        await element.waitForClickable({ timeout: TestbenchDefaults.WAIT_TIMEOUT_MS });
        await element.click();
    }

    async type(selector: string, value: string, clear = true): Promise<void> {
        const element = await this.session.active.$(selector);
        await element.waitForDisplayed({ timeout: TestbenchDefaults.WAIT_TIMEOUT_MS });

        if (clear) {
            await element.clearValue();
        }

        await element.setValue(value);
    }

    async elementAction(input: ElementActionRequest): Promise<unknown> {
        const action = InputSchemas.elementAction.parse(input);
        const browser = this.session.active;
        const element =
            action.action !== 'press' || action.selector
                ? browser.$(action.selector ?? '')
                : undefined;

        switch (action.action) {
            case 'state':
                return element?.state();
            case 'count':
                return browser.elementCount(action.selector);
            case 'fill':
                await element?.clearValue();
                await element?.setValue(action.value);
                break;
            case 'type':
                await element?.setValue(action.value);
                break;
            case 'clear':
                await element?.clearValue();
                break;
            case 'check':
                await element?.setChecked(true);
                break;
            case 'uncheck':
                await element?.setChecked(false);
                break;
            case 'select':
                await element?.select(action.values, action.by);
                break;
            case 'upload':
                await element?.upload(action.paths);
                break;
            case 'focus':
                await element?.focus();
                break;
            case 'blur':
                await element?.blur();
                break;
            case 'submit':
                await element?.submit();
                break;
            case 'scrollIntoView':
                await element?.scrollIntoView();
                break;
            case 'screenshot':
                return { base64: await element?.screenshot() };
            case 'hover':
            case 'doubleClick':
            case 'rightClick':
                await browser.mouse(action.action, action.selector);
                break;
            case 'press':
                await browser.press(action.keys, action.selector);
                break;
            case 'drag':
                await browser.drag(action.selector, action.target);
                break;
        }

        return { completed: action.action };
    }

    async browserAction(input: BrowserActionRequest): Promise<unknown> {
        const action = InputSchemas.browserAction.parse(input);
        const browser = this.session.active;

        switch (action.action) {
            case 'back':
                await browser.back();
                break;
            case 'forward':
                await browser.forward();
                break;
            case 'refresh':
                await browser.refresh();
                break;
            case 'scroll':
                await browser.scroll(action.x, action.y);
                break;
            case 'windows':
                return browser.windows();
            case 'newWindow':
                await browser.newWindow(action.type);
                break;
            case 'switchWindow':
                await browser.switchWindow(action.handle);
                break;
            case 'closeWindow':
                await browser.closeWindow();
                break;
            case 'frame':
                await browser.switchFrame(action.selector);
                break;
            case 'alert':
                return { text: await browser.alert(action.behavior, action.text) };
            case 'cookies':
                return browser.cookies();
            case 'accessibility':
                try {
                    return await browser.devtools('Accessibility.getFullAXTree', {});
                } catch {
                    return this.inspect(TestbenchDefaults.INSPECTION_MAX);
                }
            case 'printPdf':
                return browser.devtools('Page.printToPDF', { printBackground: true });
            case 'setCookie':
                await browser.setCookie(action.cookie);
                break;
            case 'deleteCookie':
                await browser.deleteCookie(action.name);
                break;
            case 'storage':
                return browser.storage(action.area);
            case 'setStorage':
                await browser.setStorage(action.area, action.key, action.value);
                break;
            case 'deleteStorage':
                await browser.deleteStorage(action.area, action.key);
                break;
            case 'viewport':
                await browser.setWindowRect(action.width, action.height);
                break;
            case 'waitDownload': {
                if (!this.target?.downloadDir) {
                    throw new Error('The session was started without a downloadDir.');
                }

                const path = join(this.target.downloadDir, action.filename);
                const startedAt = Date.now();

                for (;;) {
                    const file = await stat(path).catch(() => undefined);

                    if (file?.isFile()) {
                        return { path, size: file.size };
                    }

                    if (Date.now() - startedAt >= action.timeoutMs) {
                        throw new Error(`Download did not finish: ${action.filename}`);
                    }

                    await new Promise((resolve) =>
                        setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS),
                    );
                }
            }
            case 'evaluate':
                return browser.execute(action.script, ...action.arguments);
            case 'network':
                await browser.networkConditions(action);
                break;
            case 'geolocation':
                await browser.geolocation(action.latitude, action.longitude, action.accuracy);
                break;
            case 'permission':
                await browser.permission(action.name, action.state, action.origin);
                break;
            case 'orientation':
                await this.appiumCommand('orientation', { orientation: action.orientation });
                break;
            case 'mobileBack':
                await this.appiumCommand('back', {});
                break;
            case 'hideKeyboard':
                await this.appiumCommand('appium/device/hide_keyboard', {});
                break;
            case 'blockUrls':
                await browser.blockUrls(action.patterns);
                break;
            case 'clipboardWrite':
                await browser.clipboardWrite(action.text);
                break;
            case 'clipboardRead':
                return { text: await browser.clipboardRead() };
        }

        return { completed: action.action };
    }

    async startRecording(options: { outputPath: string; scope?: 'screen' | 'viewport' }): Promise<{
        id: string;
        capturesAudio: boolean;
        startedAt: string;
        startedAtMonotonicMs: number;
        requestedScope: 'screen' | 'viewport';
        actualScope: 'screen' | 'viewport';
        geometry: { samples: GeometrySample[] };
    }> {
        if (this.video) {
            throw new TestbenchError(
                'RECORDING_ALREADY_ACTIVE',
                'A recording is already active for this session.',
                {
                    operation: 'recording.start',
                    status: 409,
                    details: { recordingId: this.video.id },
                },
            );
        }

        if (!this.target) {
            throw new Error('No interactive target is active.');
        }

        if (
            this.target.name === 'safari-ios' &&
            this.target.deviceKind === 'physical' &&
            !this.preparedCapture
        ) {
            throw new LocalizedError({ key: 'recording.errors.iosSession' }, 409);
        }

        if (this.target.name === 'chrome-android' && this.appium) {
            await AndroidBrowserUi.dismissTransientPrompts(
                this.appium.port,
                this.session.active.sessionId,
            );
        }

        const id = randomUUID();
        const scope = options.scope ?? 'screen';
        const geometry = [
            await RecordingGeometry.capture(this.session.active, this.target, this.appium?.port),
        ];
        const recorder = await VideoRecorder.start(
            this.target,
            options.outputPath,
            this.session.active,
            geometry[0]!,
            scope,
            this.preparedCapture,
        );
        this.video = {
            id,
            recorder,
            path: options.outputPath,
            scope,
            geometry,
            startedAtMs: recorder.startedAtMonotonicMs,
        };
        this.lastRecording = undefined;
        return {
            id,
            startedAt: new Date().toISOString(),
            startedAtMonotonicMs: recorder.startedAtMonotonicMs,
            capturesAudio: recorder.capturesAudio,
            requestedScope: scope,
            actualScope: scope,
            geometry: { samples: geometry },
        };
    }

    async stopRecording(signal?: AbortSignal): Promise<
        RecordingArtifact & {
            id: string;
            requestedScope: 'screen' | 'viewport';
            actualScope: 'screen' | 'viewport';
            geometry: { samples: GeometrySample[] };
        }
    > {
        if (!this.video) {
            if (this.lastRecording) {
                return this.lastRecording;
            }

            throw new TestbenchError(
                'RECORDING_NOT_ACTIVE',
                'This session has no active recording.',
                {
                    operation: 'recording.stop',
                    status: 409,
                },
            );
        }

        const video = this.video;
        const endingGeometry = await RecordingGeometry.capture(
            this.session.active,
            this.target!,
            this.appium?.port,
        );

        if (!RecordingGeometry.equal(video.geometry[0]!, endingGeometry)) {
            video.geometry.push(endingGeometry);
        }

        const artifact = await video.recorder.stop(signal);
        this.video = undefined;

        if (video.geometry.length !== 1) {
            throw new TestbenchError(
                'RECORDING_GEOMETRY_CHANGED',
                'Viewport geometry changed during recording.',
                {
                    operation: 'recording.stop',
                    status: 409,
                    details: { partialArtifact: artifact },
                },
            );
        }

        const sample = video.geometry[0]!;
        const expectedVideo = video.scope === 'viewport' ? sample.viewportInVideo : sample.video;

        // Encoders may align odd dimensions, but a wrong screen/capture must not pass.
        if (
            Math.abs(artifact.width - expectedVideo.width) > 3 ||
            Math.abs(artifact.height - expectedVideo.height) > 1
        ) {
            throw new TestbenchError(
                'RECORDING_GEOMETRY_CHANGED',
                'Recording and requested geometry do not have the same bounds.',
                {
                    operation: 'recording.stop',
                    status: 409,
                    details: {
                        recording: { width: artifact.width, height: artifact.height },
                        screenshot: { width: expectedVideo.width, height: expectedVideo.height },
                        partialArtifact: artifact,
                    },
                },
            );
        }

        const viewport =
            video.scope === 'viewport'
                ? {
                      ...sample.viewportInVideo,
                      x: 0,
                      y: 0,
                      width: artifact.width,
                      height: artifact.height,
                  }
                : sample.viewportInVideo;
        this.lastRecording = {
            ...artifact,
            id: video.id,
            requestedScope: video.scope,
            actualScope: video.scope,
            geometry: {
                samples: [
                    {
                        ...sample,
                        video: { width: artifact.width, height: artifact.height },
                        viewportInVideo: viewport,
                        insets: {
                            ...sample.insets,
                            top: viewport.y,
                            left: viewport.x,
                            right: artifact.width - viewport.x - viewport.width,
                            bottom: artifact.height - viewport.y - viewport.height,
                        },
                    },
                ],
            },
        };
        return this.lastRecording;
    }

    async screenshot(path?: string, fullPage = false): Promise<{ path: string; base64: string }> {
        const output =
            path ?? join(process.cwd(), 'artifacts', 'interactive', `screenshot-${Date.now()}.png`);
        await mkdir(dirname(output), { recursive: true });
        const base64 = await this.captureScreenshot(fullPage);
        await writeFile(output, Buffer.from(base64, 'base64'));
        return { path: output, base64 };
    }

    async captureScreenshot(fullPage = false): Promise<string> {
        if (!fullPage) {
            return this.session.active.takeScreenshot();
        }

        if (this.target?.name === 'chrome-android') {
            throw new Error(
                'Full-page screenshots are not supported by Chrome on Android. Capture a viewport screenshot instead.',
            );
        }

        return this.session.active.takeFullPageScreenshot();
    }

    async captureStructuredScreenshot(
        scope: ScreenshotScope,
        selector?: string,
    ): Promise<ScreenshotResult> {
        if (!this.target) {
            throw new Error('No interactive target is active.');
        }

        const browser = this.session.active;
        const mobile = this.target.name === 'chrome-android' || this.target.name === 'safari-ios';

        if (scope === 'element') {
            if (!selector) {
                throw new TypeError('Element screenshots require a selector.');
            }

            const state = await browser.elementState(selector);
            const rect = state.rect as { x: number; y: number; width: number; height: number };
            return ScreenshotUtilities.result(await browser.$(selector).screenshot(), scope, null, {
                ...rect,
                coordinateSystem: 'viewport-css-pixels',
                edges: 'left-top-inclusive-right-bottom-exclusive',
            });
        }

        if (scope === 'fullPage') {
            if (mobile) {
                throw this.screenshotUnsupported(scope);
            }

            return ScreenshotUtilities.result(
                await browser.takeFullPageScreenshot(),
                scope,
                null,
                null,
            );
        }

        if (scope === 'screen') {
            if (!mobile) {
                throw this.screenshotUnsupported(scope);
            }

            const base64 = await RecordingGeometry.screenScreenshot(browser, this.appium?.port);
            const size = ImageDimensions.png(Buffer.from(base64, 'base64'));
            const geometry = await RecordingGeometry.capture(
                browser,
                this.target,
                this.appium?.port,
            );
            return ScreenshotUtilities.result(
                base64,
                scope,
                {
                    x: 0,
                    y: 0,
                    ...size,
                    coordinateSystem: 'video-pixels',
                    edges: 'left-top-inclusive-right-bottom-exclusive',
                },
                {
                    x: 0,
                    y: 0,
                    ...geometry.viewportCss,
                    coordinateSystem: 'viewport-css-pixels',
                    edges: 'left-top-inclusive-right-bottom-exclusive',
                },
            );
        }

        if (!mobile) {
            if (this.target.name === 'safari') {
                const base64 = await browser.$('body').screenshot();
                const size = ImageDimensions.png(Buffer.from(base64, 'base64'));

                return ScreenshotUtilities.result(base64, scope, null, {
                    x: 0,
                    y: 0,
                    ...size,
                    coordinateSystem: 'viewport-css-pixels',
                    edges: 'left-top-inclusive-right-bottom-exclusive',
                });
            }

            const screenshot = await browser.takeScreenshot();
            const base64 =
                this.target.name === 'firefox'
                    ? await ScreenshotUtilities.withoutTransparentBottomRows(screenshot)
                    : screenshot;
            const size = ImageDimensions.png(Buffer.from(base64, 'base64'));
            return ScreenshotUtilities.result(base64, scope, null, {
                x: 0,
                y: 0,
                ...size,
                coordinateSystem: 'viewport-css-pixels',
                edges: 'left-top-inclusive-right-bottom-exclusive',
            });
        }

        const geometry = await RecordingGeometry.capture(browser, this.target, this.appium?.port);
        const screen = await RecordingGeometry.screenScreenshot(browser, this.appium?.port);
        const base64 = await ScreenshotUtilities.crop(screen, geometry.viewportInVideo);
        return ScreenshotUtilities.result(base64, scope, geometry.viewportInVideo, {
            x: 0,
            y: 0,
            ...geometry.viewportCss,
            coordinateSystem: 'viewport-css-pixels',
            edges: 'left-top-inclusive-right-bottom-exclusive',
        });
    }

    private screenshotUnsupported(scope: ScreenshotScope): TestbenchError {
        return new TestbenchError(
            'SCREENSHOT_SCOPE_UNSUPPORTED',
            `Screenshot scope '${scope}' is not supported.`,
            {
                operation: 'screenshot.capture',
                status: 409,
                details: { target: this.target?.name, scope },
            },
        );
    }

    async source(maxCharacters = TestbenchDefaults.PAGE_SOURCE_LIMIT): Promise<string> {
        return (await this.session.active.getPageSource()).slice(0, maxCharacters);
    }

    async gesture(input: GestureRequest): Promise<GestureExecution> {
        if (!this.target) {
            throw new Error('No interactive target is active.');
        }

        return MobileGestures.perform(this.session.active, this.target, input);
    }

    async wait(input: WaitRequest, signal?: AbortSignal): Promise<void> {
        const request = InputSchemas.wait.parse(input);

        if (request.type === 'element') {
            await this.session.active.waitForElement(request.selector, request.timeoutMs, signal);
        }

        if (request.type === 'text') {
            await this.session.active.waitForText(request.text, request.timeoutMs, signal);
        }

        if (request.type === 'url') {
            await this.session.active.waitForUrl(request.value, request.timeoutMs, signal);
        }

        if (request.type === 'state') {
            await this.session.active.waitForState(
                request.selector,
                request.state,
                request.timeoutMs,
                signal,
            );
        }

        if (request.type === 'value') {
            await this.session.active.waitForValue(
                request.selector,
                request.value,
                request.timeoutMs,
                signal,
            );
        }

        if (request.type === 'count') {
            await this.session.active.waitForCount(
                request.selector,
                request.count,
                request.timeoutMs,
                signal,
            );
        }

        if (request.type === 'attribute') {
            await this.session.active.waitForAttribute(
                request.selector,
                request.name,
                request.value,
                request.timeoutMs,
                signal,
            );
        }

        if (request.type === 'elementText') {
            await this.session.active.waitForElementText(
                request.selector,
                request.text,
                request.timeoutMs,
                signal,
            );
        }

        if (request.type === 'windowCount') {
            await this.session.active.waitForWindowCount(request.count, request.timeoutMs, signal);
        }

        if (request.type === 'networkIdle') {
            await this.session.active.waitForNetworkIdle(
                request.quietMs,
                request.timeoutMs,
                signal,
            );
        }

        if (request.type === 'script') {
            await this.session.active.waitForScript(
                request.script,
                request.arguments,
                request.timeoutMs,
                signal,
            );
        }
    }

    async diagnostics(): Promise<DiagnosticEvent[]> {
        return this.browserDiagnostics.read(this.session.active);
    }

    async diagnosticBundle(): Promise<Record<string, unknown>> {
        const [screenshot, source, diagnostics, inspection] = await Promise.allSettled([
            this.captureStructuredScreenshot('viewport'),
            this.source(TestbenchDefaults.PAGE_SOURCE_MAX),
            this.diagnostics(),
            this.inspect(1),
        ]);
        const recording = this.lastRecording
            ? { ...this.lastRecording, path: basename(this.lastRecording.path) }
            : this.video
              ? {
                    id: this.video.id,
                    active: true,
                    scope: this.video.scope,
                    geometry: { samples: this.video.geometry },
                }
              : undefined;
        return {
            target: this.target
                ? {
                      name: this.target.name,
                      deviceKind: this.target.deviceKind,
                      deviceName: this.target.deviceName,
                  }
                : undefined,
            url: inspection.status === 'fulfilled' ? inspection.value.url : undefined,
            dom: source.status === 'fulfilled' ? source.value : undefined,
            screenshot: screenshot.status === 'fulfilled' ? screenshot.value : undefined,
            browserEvents: diagnostics.status === 'fulfilled' ? diagnostics.value : [],
            permissions: this.permissions.metadata,
            recording,
            cleanup: { state: this.target ? 'active' : 'complete' },
            errors: [screenshot, source, diagnostics, inspection]
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result) =>
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                ),
        };
    }

    clearDiagnostics(): void {
        this.browserDiagnostics.clear();
    }

    async debugTools(): Promise<Record<string, unknown>> {
        if (!this.target) {
            throw new Error('No interactive target is active.');
        }

        if (this.target.name === 'safari-ios') {
            return {
                tool: 'Safari Web Inspector',
                automatic: false,
                steps: [
                    'Open Safari on the Mac and enable Develop menu in Safari Settings → Advanced.',
                    `Open Develop and select the ${this.target.deviceKind === 'physical' ? 'connected iPhone or iPad' : 'iOS Simulator'} and its current page.`,
                ],
            };
        }

        if (this.target.name === 'chrome-android') {
            return { tool: 'Chrome DevTools', automatic: false, url: 'chrome://inspect/#devices' };
        }

        const url = await this.session.active.devToolsFrontendUrl();

        if (url) {
            return { tool: 'Chrome DevTools', automatic: true, url };
        }

        return {
            tool: 'Testbench diagnostics',
            automatic: true,
            detail: 'Console output, HTTP requests/responses, and WebSocket connections/frames are available through the diagnostics endpoint.',
        };
    }

    private async appiumCommand<T = void>(path: string, body: Record<string, unknown>): Promise<T> {
        if (!this.appium) {
            throw new Error('This command requires an active mobile session.');
        }

        try {
            return await new AppiumSessionClient(
                this.appium.port,
                this.session.active.sessionId,
            ).request<T>(path, 'POST', body, TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS);
        } catch (error) {
            if (
                error instanceof Error &&
                (error.name === 'TimeoutError' || error.name === 'AbortError')
            ) {
                throw new Error(
                    `Appium command timed out after ${TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS} ms.`,
                );
            }

            throw error;
        }
    }

    async close(): Promise<{ videoPath?: string }> {
        const target = this.target;
        const failures: unknown[] = [];
        let videoPath: string | undefined;

        if (this.video) {
            try {
                videoPath = (await this.video.recorder.stop()).path;
                this.video = undefined;
            } catch (error) {
                failures.push(error);
            }
        } else {
            videoPath = this.lastRecording?.path;
        }

        await this.permissions
            .resetOrigins(this.target!, () => this.session.active)
            .catch((error) => failures.push(error));
        await this.permissions.restoreNative().catch((error) => failures.push(error));
        const browserClose = (this.pendingBrowserClose ??= this.session.close());
        let browserCloseTimedOut = false;
        let browserCloseFailure: unknown;
        await this.withCleanupTimeout('browser session', browserClose).catch((error) => {
            if (error instanceof CleanupTimeoutError) {
                browserCloseTimedOut = true;
            } else {
                browserCloseFailure = error;
            }
        });

        if (!browserCloseTimedOut) {
            this.pendingBrowserClose = undefined;
        }

        let appiumStopped = false;

        if (this.appium) {
            await this.appium.process
                .stop()
                .then(() => {
                    appiumStopped = true;
                })
                .catch((error) => failures.push(error));
        }

        if (browserCloseTimedOut) {
            await this.withCleanupTimeout('browser session after stopping Appium', browserClose)
                .then(() => (this.pendingBrowserClose = undefined))
                .catch((error) => (browserCloseFailure = error));
        }

        if (
            browserCloseFailure &&
            !(
                target?.name === 'chrome-android' &&
                appiumStopped &&
                browserCloseFailure instanceof Error &&
                browserCloseFailure.message.includes('tab crashed')
            )
        ) {
            failures.push(browserCloseFailure);
        }

        await IosSessionCleanup.run(target).catch((error) => failures.push(error));
        await this.preparedCapture?.workspace.close().catch((error) => failures.push(error));
        this.preparedCapture = undefined;

        if (failures.length > 0) {
            throw new AggregateError(failures, 'Session cleanup failed.');
        }

        this.clearState();
        return { videoPath };
    }

    private clearState(): void {
        this.video = undefined;
        this.lastRecording = undefined;
        this.appium = undefined;
        this.target = undefined;
        this.browserDiagnostics.clear();
        this.permissions.clear();
        this.pendingBrowserClose = undefined;
    }

    private async iosStartupDiagnostic(target: TargetConfig, error: unknown): Promise<string> {
        const appium = this.appium?.process;

        if (!appium || target.name !== 'safari-ios' || target.deviceKind !== 'physical') {
            return appium?.recentOutput ?? '';
        }

        if (IosPhysicalStartupError.isSafariDebuggerTimeout(error)) {
            return appium.recentOutput;
        }

        const deadline = Date.now() + TestbenchDefaults.IOS_STARTUP_DIAGNOSTIC_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const output = appium.recentOutput;

            if (IosPhysicalStartupError.hasTerminalDiagnostic(output)) {
                return output;
            }

            await new Promise((resolve) =>
                setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS),
            );
        }

        return appium.recentOutput;
    }

    private async withCleanupTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;

        try {
            return await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new CleanupTimeoutError(`Timed out while closing the ${label}.`),
                            ),
                        TestbenchDefaults.REMOTE_CLEANUP_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
}
