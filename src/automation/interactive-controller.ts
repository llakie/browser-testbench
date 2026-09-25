import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { TestbenchDefaults } from "../config/defaults.js";
import {
  InputSchemas,
  type BrowserActionRequest,
  type ElementActionRequest,
  type StartSessionInput,
  type WaitRequest,
} from "../config/input-schemas.js";
import type { GestureRequest } from "../config/input-schemas.js";
import { TargetRegistry } from "../config/target-registry.js";
import type { TargetConfig, TargetName } from "../config/types.js";
import { ServiceManager, type ManagedProcess } from "../infrastructure/process-manager.js";
import { BrowserSession } from "./browser-session.js";
import { AppiumSessionClient } from "./appium-session-client.js";
import { IosPhysicalStartupError } from "./ios-physical-startup-error.js";
import { IosPhysicalSafariNavigator } from "./ios-physical-safari-navigator.js";
import { IosSessionCleanup } from "./ios-session-cleanup.js";
import { MobileGestures, type GestureExecution } from "./mobile-gestures.js";
import { PageInspectionScript } from "./page-inspection-script.js";
import { RecordingProbe, VideoRecorder, type RecordingArtifact } from "./video-recorder.js";
import { randomUUID } from "node:crypto";
import { AndroidCameraUtilities } from "./android-camera-utilities.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { ImageDimensions, RecordingGeometry, type GeometrySample } from "./recording-geometry.js";
import { VideoUtilities } from "./video-utilities.js";
import { ScreenshotUtilities, type ScreenshotResult, type ScreenshotScope } from "./screenshot-utilities.js";
import { AbortableOperation } from "./abortable-operation.js";
import { AndroidDeviceUtilities } from "./android-device-utilities.js";

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

export interface DiagnosticEvent {
  type: "console" | "request" | "response" | "requestFailed" | "webSocket" | "webSocketFrame";
  timestamp: string;
  level?: string;
  message?: string;
  requestId?: string;
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  headers?: Record<string, unknown>;
  body?: string;
  error?: string;
  durationMs?: number;
  phase?: "created" | "handshakeRequest" | "handshakeResponse" | "closed" | "error";
  direction?: "sent" | "received";
  opcode?: number;
}

export type ResolvedStartSessionInput = Omit<StartSessionInput, "target"> & {
  target: TargetName;
  targetId: string;
  deviceName?: string;
  platformVersion?: string;
  avd?: string;
  udid?: string;
  deviceKind?: TargetConfig["deviceKind"];
  iosTeamId?: string;
  iosSigningId?: string;
  wdaBundleId?: string;
};

class CleanupTimeoutError extends Error {}

export class InteractiveController {
  private readonly session = new BrowserSession();
  private appium?: { process: ManagedProcess; port: number };
  private target?: TargetConfig;
  private video?: {
    id: string;
    recorder: VideoRecorder;
    path: string;
    scope: "screen" | "viewport";
    geometry: GeometrySample[];
    startedAtMs: number;
  };
  private lastRecording?: RecordingArtifact & {
    id: string;
    requestedScope: "screen" | "viewport";
    actualScope: "screen" | "viewport";
    geometry: { samples: GeometrySample[] };
  };
  private readonly diagnosticEvents: DiagnosticEvent[] = [];
  private readonly requestTimestamps = new Map<string, number>();
  private readonly webSocketUrls = new Map<string, string>();
  private androidPermissions?: AndroidCameraUtilities;
  private originPermissions: Array<{ name: string; origin: string }> = [];
  private pendingBrowserClose?: Promise<void>;
  private permissionMetadata?: {
    requested: Array<{ name: string; origin: string }>;
    confirmed: Array<{ name: string; origin: string }>;
    packageName?: string;
  };

  async start(options: ResolvedStartSessionInput): Promise<Record<string, unknown>> {
    if (!TargetRegistry.isSupported(options.target))
      throw new Error(`${options.target} is not supported on ${process.platform}.`);
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
    const initialDeeplink = Boolean(options.url && IosPhysicalSafariNavigator.supportsInitialDeeplink(target));
    if (!initialDeeplink) target.initialUrl = undefined;
    const attempts =
      target.name === "safari-ios" && target.deviceKind === "physical"
        ? TestbenchDefaults.IOS_SESSION_START_ATTEMPTS
        : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.target = target;
      let browserStarted = false;
      try {
        if (TargetRegistry.definitions[options.target].kind === "mobile")
          this.appium = await ServiceManager.startAppium();
        const browser = await this.session.start(target, { appiumPort: this.appium?.port, targetId: options.targetId });
        browserStarted = true;
        if (target.name === "chrome-android") {
          target.udid ??= AndroidDeviceUtilities.configuredSerial(target, browser.capabilities);
        }
        const permissions = await this.preparePermissions(target, browser, options.permissions ?? []);
        this.permissionMetadata = permissions;
        if (options.videoPath) {
          await this.startRecording({ outputPath: options.videoPath, scope: "screen" });
        }
        if (options.url) {
          if (initialDeeplink) {
            if (!this.appium) throw new Error("The Appium service for this iOS session is not available.");
            await IosPhysicalSafariNavigator.navigate(this.appium.port, browser.sessionId, options.url, target);
          } else {
            await this.session.navigate(options.url);
          }
        }
        return {
          target: options.targetId,
          browser: options.target,
          sessionId: browser.sessionId,
          capabilities: browser.capabilities,
          url: options.url,
          ...(target.name === "chrome-android" && options.url
            ? {
                localOrigin: {
                  mode: target.localOrigins ?? "reverse",
                  requested: new URL(options.url).origin,
                  actual: new URL(await this.session.active.getUrl()).origin,
                },
              }
            : {}),
          permissions,
        };
      } catch (error) {
        const appiumOutput = browserStarted ? "" : await this.iosStartupDiagnostic(target, error);
        const reportedError = IosPhysicalStartupError.from(error, target, appiumOutput);
        try {
          await this.close();
        } catch (cleanupError) {
          throw new AggregateError([reportedError, cleanupError], "Browser session startup and cleanup failed.");
        }
        if (attempt < attempts && IosPhysicalStartupError.isSafariDebuggerTimeout(error)) continue;
        throw reportedError;
      }
    }
    throw new Error("Browser session startup failed.");
  }

  async navigate(url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PageInspection> {
    if (!this.target) throw new Error("No interactive target is active.");
    if (this.target.name === "safari-ios" && this.target.deviceKind === "physical") {
      if (!this.appium) throw new Error("The Appium service for this iOS session is not available.");
      await AbortableOperation.run(
        IosPhysicalSafariNavigator.navigate(this.appium.port, this.session.active.sessionId, url, this.target),
        { name: "navigate", timeoutMs: options.timeoutMs, signal: options.signal, details: { url } },
      );
      try {
        return await this.inspect();
      } catch (error) {
        if (IosPhysicalStartupError.isSafariDebuggerTimeout(error)) return { url, title: "", elements: [] };
        throw error;
      }
    } else {
      await this.session.navigate(url, options);
    }
    return this.inspect();
  }

  async inspect(limit = TestbenchDefaults.INSPECTION_LIMIT): Promise<PageInspection> {
    const browser = this.session.active;
    const elements = await browser.execute<PageInspection["elements"]>(
      PageInspectionScript.SOURCE,
      limit,
      TestbenchDefaults.INSPECTED_TEXT_MAX_LENGTH,
    );
    return {
      url: await browser.getUrl(),
      title: await browser.getTitle(),
      elements: elements as PageInspection["elements"],
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
    if (clear) await element.clearValue();
    await element.setValue(value);
  }

  async elementAction(input: ElementActionRequest): Promise<unknown> {
    const action = InputSchemas.elementAction.parse(input);
    const browser = this.session.active;
    const element = action.action !== "press" || action.selector ? browser.$(action.selector ?? "") : undefined;
    switch (action.action) {
      case "state":
        return element?.state();
      case "count":
        return browser.elementCount(action.selector);
      case "fill":
        await element?.clearValue();
        await element?.setValue(action.value);
        break;
      case "type":
        await element?.setValue(action.value);
        break;
      case "clear":
        await element?.clearValue();
        break;
      case "check":
        await element?.setChecked(true);
        break;
      case "uncheck":
        await element?.setChecked(false);
        break;
      case "select":
        await element?.select(action.values, action.by);
        break;
      case "upload":
        await element?.upload(action.paths);
        break;
      case "focus":
        await element?.focus();
        break;
      case "blur":
        await element?.blur();
        break;
      case "submit":
        await element?.submit();
        break;
      case "scrollIntoView":
        await element?.scrollIntoView();
        break;
      case "screenshot":
        return { base64: await element?.screenshot() };
      case "hover":
      case "doubleClick":
      case "rightClick":
        await browser.mouse(action.action, action.selector);
        break;
      case "press":
        await browser.press(action.keys, action.selector);
        break;
      case "drag":
        await browser.drag(action.selector, action.target);
        break;
    }
    return { completed: action.action };
  }

  async browserAction(input: BrowserActionRequest): Promise<unknown> {
    const action = InputSchemas.browserAction.parse(input);
    const browser = this.session.active;
    switch (action.action) {
      case "back":
        await browser.back();
        break;
      case "forward":
        await browser.forward();
        break;
      case "refresh":
        await browser.refresh();
        break;
      case "scroll":
        await browser.scroll(action.x, action.y);
        break;
      case "windows":
        return browser.windows();
      case "newWindow":
        await browser.newWindow(action.type);
        break;
      case "switchWindow":
        await browser.switchWindow(action.handle);
        break;
      case "closeWindow":
        await browser.closeWindow();
        break;
      case "frame":
        await browser.switchFrame(action.selector);
        break;
      case "alert":
        return { text: await browser.alert(action.behavior, action.text) };
      case "cookies":
        return browser.cookies();
      case "accessibility":
        try {
          return await browser.devtools("Accessibility.getFullAXTree", {});
        } catch {
          return this.inspect(TestbenchDefaults.INSPECTION_MAX);
        }
      case "printPdf":
        return browser.devtools("Page.printToPDF", { printBackground: true });
      case "setCookie":
        await browser.setCookie(action.cookie);
        break;
      case "deleteCookie":
        await browser.deleteCookie(action.name);
        break;
      case "storage":
        return browser.storage(action.area);
      case "setStorage":
        await browser.setStorage(action.area, action.key, action.value);
        break;
      case "deleteStorage":
        await browser.deleteStorage(action.area, action.key);
        break;
      case "viewport":
        await browser.setWindowRect(action.width, action.height);
        break;
      case "waitDownload": {
        if (!this.target?.downloadDir) throw new Error("The session was started without a downloadDir.");
        const path = join(this.target.downloadDir, action.filename);
        const startedAt = Date.now();
        for (;;) {
          const file = await stat(path).catch(() => undefined);
          if (file?.isFile()) return { path, size: file.size };
          if (Date.now() - startedAt >= action.timeoutMs)
            throw new Error(`Download did not finish: ${action.filename}`);
          await new Promise((resolve) => setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS));
        }
      }
      case "evaluate":
        return browser.execute(action.script, ...action.arguments);
      case "network":
        await browser.networkConditions(action);
        break;
      case "geolocation":
        await browser.geolocation(action.latitude, action.longitude, action.accuracy);
        break;
      case "permission":
        await browser.permission(action.name, action.state, action.origin);
        break;
      case "orientation":
        await this.appiumCommand("orientation", { orientation: action.orientation });
        break;
      case "mobileBack":
        await this.appiumCommand("back", {});
        break;
      case "hideKeyboard":
        await this.appiumCommand("appium/device/hide_keyboard", {});
        break;
      case "blockUrls":
        await browser.blockUrls(action.patterns);
        break;
      case "clipboardWrite":
        await browser.clipboardWrite(action.text);
        break;
      case "clipboardRead":
        return { text: await browser.clipboardRead() };
    }
    return { completed: action.action };
  }

  async startRecording(options: { outputPath: string; scope?: "screen" | "viewport" }): Promise<{
    id: string;
    startedAt: string;
    requestedScope: "screen" | "viewport";
    actualScope: "screen" | "viewport";
    geometry: { samples: GeometrySample[] };
  }> {
    if (this.video)
      throw new TestbenchError("RECORDING_ALREADY_ACTIVE", "A recording is already active for this session.", {
        operation: "recording.start",
        status: 409,
        details: { recordingId: this.video.id },
      });
    if (!this.target) throw new Error("No interactive target is active.");
    const id = randomUUID();
    const scope = options.scope ?? "screen";
    const geometry = [await RecordingGeometry.capture(this.session.active, this.target, this.appium?.port)];
    const recorder = await VideoRecorder.start(this.target, options.outputPath, this.session.active.capabilities);
    this.video = { id, recorder, path: options.outputPath, scope, geometry, startedAtMs: performance.now() };
    this.lastRecording = undefined;
    return {
      id,
      startedAt: new Date().toISOString(),
      requestedScope: scope,
      actualScope: scope,
      geometry: { samples: geometry },
    };
  }

  async stopRecording(signal?: AbortSignal): Promise<
    RecordingArtifact & {
      id: string;
      requestedScope: "screen" | "viewport";
      actualScope: "screen" | "viewport";
      geometry: { samples: GeometrySample[] };
    }
  > {
    if (!this.video) {
      if (this.lastRecording) return this.lastRecording;
      throw new TestbenchError("RECORDING_NOT_ACTIVE", "This session has no active recording.", {
        operation: "recording.stop",
        status: 409,
      });
    }
    const video = this.video;
    const endingGeometry = await RecordingGeometry.capture(this.session.active, this.target!, this.appium?.port);
    if (!RecordingGeometry.equal(video.geometry[0]!, endingGeometry)) video.geometry.push(endingGeometry);
    const recordedDurationMs = Math.max(1, Math.round(performance.now() - video.startedAtMs));
    let artifact = await video.recorder.stop(signal);
    const repairDuration = artifact.durationMs + 100 < recordedDurationMs ? recordedDurationMs : undefined;
    if (video.scope === "viewport") {
      if (video.geometry.length !== 1)
        throw new TestbenchError("RECORDING_GEOMETRY_CHANGED", "Viewport geometry changed during recording.", {
          operation: "recording.stop",
          status: 409,
          details: { partialArtifact: artifact, samples: video.geometry },
        });
      await VideoUtilities.crop(artifact.path, video.geometry[0]!.viewportInVideo, repairDuration);
      artifact = await RecordingProbe.inspect(artifact.path);
    } else if (repairDuration) {
      await VideoUtilities.normalizeDuration(artifact.path, repairDuration);
      artifact = await RecordingProbe.inspect(artifact.path);
    }
    this.video = undefined;
    this.lastRecording = {
      ...artifact,
      id: video.id,
      requestedScope: video.scope,
      actualScope: video.scope,
      geometry: { samples: video.geometry },
    };
    return this.lastRecording;
  }

  async screenshot(path?: string, fullPage = false): Promise<{ path: string; base64: string }> {
    const output = path ?? join(process.cwd(), "artifacts", "interactive", `screenshot-${Date.now()}.png`);
    await mkdir(dirname(output), { recursive: true });
    const base64 = await this.captureScreenshot(fullPage);
    await writeFile(output, Buffer.from(base64, "base64"));
    return { path: output, base64 };
  }

  async captureScreenshot(fullPage = false): Promise<string> {
    if (!fullPage) return this.session.active.takeScreenshot();
    if (this.target?.name === "chrome-android") {
      throw new Error(
        "Full-page screenshots are not supported by Chrome on Android. Capture a viewport screenshot instead.",
      );
    }
    return this.session.active.takeFullPageScreenshot();
  }

  async captureStructuredScreenshot(scope: ScreenshotScope, selector?: string): Promise<ScreenshotResult> {
    if (!this.target) throw new Error("No interactive target is active.");
    const browser = this.session.active;
    const mobile = this.target.name === "chrome-android" || this.target.name === "safari-ios";
    if (scope === "element") {
      if (!selector) throw new TypeError("Element screenshots require a selector.");
      const state = await browser.elementState(selector);
      const rect = state.rect as { x: number; y: number; width: number; height: number };
      return ScreenshotUtilities.result(await browser.$(selector).screenshot(), scope, null, {
        ...rect,
        coordinateSystem: "viewport-css-pixels",
        edges: "left-top-inclusive-right-bottom-exclusive",
      });
    }
    if (scope === "fullPage") {
      if (mobile) throw this.screenshotUnsupported(scope);
      return ScreenshotUtilities.result(await browser.takeFullPageScreenshot(), scope, null, null);
    }
    if (scope === "screen") {
      if (!mobile) throw this.screenshotUnsupported(scope);
      const base64 = await RecordingGeometry.screenScreenshot(browser, this.appium?.port);
      const size = ImageDimensions.png(Buffer.from(base64, "base64"));
      const geometry = await RecordingGeometry.capture(browser, this.target, this.appium?.port);
      return ScreenshotUtilities.result(
        base64,
        scope,
        {
          x: 0,
          y: 0,
          ...size,
          coordinateSystem: "video-pixels",
          edges: "left-top-inclusive-right-bottom-exclusive",
        },
        {
          x: 0,
          y: 0,
          ...geometry.viewportCss,
          coordinateSystem: "viewport-css-pixels",
          edges: "left-top-inclusive-right-bottom-exclusive",
        },
      );
    }
    if (!mobile) {
      const base64 = await browser.takeScreenshot();
      const size = ImageDimensions.png(Buffer.from(base64, "base64"));
      return ScreenshotUtilities.result(base64, scope, null, {
        x: 0,
        y: 0,
        ...size,
        coordinateSystem: "viewport-css-pixels",
        edges: "left-top-inclusive-right-bottom-exclusive",
      });
    }
    const geometry = await RecordingGeometry.capture(browser, this.target, this.appium?.port);
    const screen = await RecordingGeometry.screenScreenshot(browser, this.appium?.port);
    const base64 = await ScreenshotUtilities.crop(screen, geometry.viewportInVideo);
    return ScreenshotUtilities.result(base64, scope, geometry.viewportInVideo, {
      x: 0,
      y: 0,
      ...geometry.viewportCss,
      coordinateSystem: "viewport-css-pixels",
      edges: "left-top-inclusive-right-bottom-exclusive",
    });
  }

  private screenshotUnsupported(scope: ScreenshotScope): TestbenchError {
    return new TestbenchError("SCREENSHOT_SCOPE_UNSUPPORTED", `Screenshot scope '${scope}' is not supported.`, {
      operation: "screenshot.capture",
      status: 409,
      details: { target: this.target?.name, scope },
    });
  }

  async source(maxCharacters = TestbenchDefaults.PAGE_SOURCE_LIMIT): Promise<string> {
    return (await this.session.active.getPageSource()).slice(0, maxCharacters);
  }

  async gesture(input: GestureRequest): Promise<GestureExecution> {
    if (!this.target) throw new Error("No interactive target is active.");
    return MobileGestures.perform(this.session.active, this.target, input);
  }

  async wait(input: WaitRequest, signal?: AbortSignal): Promise<void> {
    const request = InputSchemas.wait.parse(input);
    if (request.type === "element")
      await this.session.active.waitForElement(request.selector, request.timeoutMs, signal);
    if (request.type === "text") await this.session.active.waitForText(request.text, request.timeoutMs, signal);
    if (request.type === "url") await this.session.active.waitForUrl(request.value, request.timeoutMs, signal);
    if (request.type === "state")
      await this.session.active.waitForState(request.selector, request.state, request.timeoutMs, signal);
    if (request.type === "value")
      await this.session.active.waitForValue(request.selector, request.value, request.timeoutMs, signal);
    if (request.type === "count")
      await this.session.active.waitForCount(request.selector, request.count, request.timeoutMs, signal);
    if (request.type === "attribute")
      await this.session.active.waitForAttribute(
        request.selector,
        request.name,
        request.value,
        request.timeoutMs,
        signal,
      );
    if (request.type === "elementText")
      await this.session.active.waitForElementText(request.selector, request.text, request.timeoutMs, signal);
    if (request.type === "windowCount")
      await this.session.active.waitForWindowCount(request.count, request.timeoutMs, signal);
    if (request.type === "networkIdle")
      await this.session.active.waitForNetworkIdle(request.quietMs, request.timeoutMs, signal);
    if (request.type === "script")
      await this.session.active.waitForScript(request.script, request.arguments, request.timeoutMs, signal);
  }

  async diagnostics(): Promise<DiagnosticEvent[]> {
    await this.collectDiagnostics();
    return [...this.diagnosticEvents];
  }

  async diagnosticBundle(): Promise<Record<string, unknown>> {
    const [screenshot, source, diagnostics, inspection] = await Promise.allSettled([
      this.captureStructuredScreenshot("viewport"),
      this.source(TestbenchDefaults.PAGE_SOURCE_MAX),
      this.diagnostics(),
      this.inspect(1),
    ]);
    const recording = this.lastRecording
      ? { ...this.lastRecording, path: basename(this.lastRecording.path) }
      : this.video
        ? { id: this.video.id, active: true, scope: this.video.scope, geometry: { samples: this.video.geometry } }
        : undefined;
    return {
      target: this.target
        ? { name: this.target.name, deviceKind: this.target.deviceKind, deviceName: this.target.deviceName }
        : undefined,
      url: inspection.status === "fulfilled" ? inspection.value.url : undefined,
      dom: source.status === "fulfilled" ? source.value : undefined,
      screenshot: screenshot.status === "fulfilled" ? screenshot.value : undefined,
      browserEvents: diagnostics.status === "fulfilled" ? diagnostics.value : [],
      permissions: this.permissionMetadata,
      recording,
      cleanup: { state: this.target ? "active" : "complete" },
      errors: [screenshot, source, diagnostics, inspection]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason))),
    };
  }

  clearDiagnostics(): void {
    this.diagnosticEvents.length = 0;
    this.requestTimestamps.clear();
    this.webSocketUrls.clear();
  }

  async debugTools(): Promise<Record<string, unknown>> {
    if (!this.target) throw new Error("No interactive target is active.");
    if (this.target.name === "safari-ios") {
      return {
        tool: "Safari Web Inspector",
        automatic: false,
        steps: [
          "Open Safari on the Mac and enable Develop menu in Safari Settings → Advanced.",
          `Open Develop and select the ${this.target.deviceKind === "physical" ? "connected iPhone or iPad" : "iOS Simulator"} and its current page.`,
        ],
      };
    }
    if (this.target.name === "chrome-android") {
      return { tool: "Chrome DevTools", automatic: false, url: "chrome://inspect/#devices" };
    }
    const url = await this.session.active.devToolsFrontendUrl();
    if (url) return { tool: "Chrome DevTools", automatic: true, url };
    return {
      tool: "Testbench diagnostics",
      automatic: true,
      detail:
        "Console output, HTTP requests/responses, and WebSocket connections/frames are available through the diagnostics endpoint.",
    };
  }

  private async collectDiagnostics(): Promise<void> {
    const browser = this.session.active;
    try {
      const entries = (await browser.logs("browser")) as Array<{
        level?: { name?: string };
        message?: string;
        timestamp?: number;
      }>;
      for (const entry of entries) {
        this.pushDiagnostic({
          type: "console",
          timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
          level: entry.level?.name,
          message: entry.message,
        });
      }
    } catch {
      // Browser logs are driver-dependent. Unsupported targets simply return no console events.
    }
    try {
      const entries = (await browser.logs("performance")) as Array<{ message?: string; timestamp?: number }>;
      for (const entry of entries) {
        const envelope = JSON.parse(entry.message ?? "{}") as {
          message?: { method?: string; params?: Record<string, unknown> };
        };
        const message = envelope.message;
        if (message?.method === "Network.requestWillBeSent") {
          const request = message.params?.request as
            { method?: string; url?: string; headers?: Record<string, unknown>; postData?: string } | undefined;
          const requestId = message.params?.requestId as string | undefined;
          const timestamp = message.params?.timestamp as number | undefined;
          if (requestId && timestamp) this.requestTimestamps.set(requestId, timestamp);
          this.pushDiagnostic({
            type: "request",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            method: request?.method,
            url: request?.url,
            headers: request?.headers,
            body: request?.postData?.slice(0, TestbenchDefaults.PAGE_SOURCE_LIMIT),
          });
        }
        if (message?.method === "Network.responseReceived") {
          const response = message.params?.response as
            { status?: number; url?: string; mimeType?: string; headers?: Record<string, unknown> } | undefined;
          const requestId = message.params?.requestId as string | undefined;
          const timestamp = message.params?.timestamp as number | undefined;
          const startedAt = requestId ? this.requestTimestamps.get(requestId) : undefined;
          const body = requestId ? await this.responseBody(browser, requestId) : undefined;
          this.pushDiagnostic({
            type: "response",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            status: response?.status,
            url: response?.url,
            mimeType: response?.mimeType,
            headers: response?.headers,
            body,
            durationMs: timestamp && startedAt ? Math.round((timestamp - startedAt) * 1_000) : undefined,
          });
          if (requestId) this.requestTimestamps.delete(requestId);
        }
        if (message?.method === "Network.loadingFailed") {
          const requestId = message.params?.requestId as string | undefined;
          this.pushDiagnostic({
            type: "requestFailed",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            error: message.params?.errorText as string | undefined,
          });
          if (requestId) this.requestTimestamps.delete(requestId);
        }
        if (message?.method === "Network.webSocketCreated") {
          const requestId = message.params?.requestId as string | undefined;
          const url = message.params?.url as string | undefined;
          if (requestId && url) this.webSocketUrls.set(requestId, url);
          this.pushDiagnostic({
            type: "webSocket",
            phase: "created",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            requestId,
            url,
          });
        }
        if (message?.method === "Network.webSocketWillSendHandshakeRequest") {
          const requestId = message.params?.requestId as string | undefined;
          const request = message.params?.request as { headers?: Record<string, unknown> } | undefined;
          this.pushDiagnostic({
            type: "webSocket",
            phase: "handshakeRequest",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            requestId,
            url: requestId ? this.webSocketUrls.get(requestId) : undefined,
            headers: request?.headers,
          });
        }
        if (message?.method === "Network.webSocketHandshakeResponseReceived") {
          const requestId = message.params?.requestId as string | undefined;
          const response = message.params?.response as
            { status?: number; statusText?: string; headers?: Record<string, unknown> } | undefined;
          this.pushDiagnostic({
            type: "webSocket",
            phase: "handshakeResponse",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            requestId,
            url: requestId ? this.webSocketUrls.get(requestId) : undefined,
            status: response?.status,
            statusText: response?.statusText,
            headers: response?.headers,
          });
        }
        if (message?.method === "Network.webSocketFrameSent" || message?.method === "Network.webSocketFrameReceived") {
          const requestId = message.params?.requestId as string | undefined;
          const frame = message.params?.response as { opcode?: number; payloadData?: string } | undefined;
          this.pushDiagnostic({
            type: "webSocketFrame",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            requestId,
            url: requestId ? this.webSocketUrls.get(requestId) : undefined,
            direction: message.method === "Network.webSocketFrameSent" ? "sent" : "received",
            opcode: frame?.opcode,
            body: frame?.payloadData?.slice(0, TestbenchDefaults.PAGE_SOURCE_LIMIT),
          });
        }
        if (message?.method === "Network.webSocketFrameError") {
          const requestId = message.params?.requestId as string | undefined;
          this.pushDiagnostic({
            type: "webSocket",
            phase: "error",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            requestId,
            url: requestId ? this.webSocketUrls.get(requestId) : undefined,
            error: message.params?.errorMessage as string | undefined,
          });
        }
        if (message?.method === "Network.webSocketClosed") {
          const requestId = message.params?.requestId as string | undefined;
          this.pushDiagnostic({
            type: "webSocket",
            phase: "closed",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            requestId,
            url: requestId ? this.webSocketUrls.get(requestId) : undefined,
          });
          if (requestId) this.webSocketUrls.delete(requestId);
        }
      }
    } catch {
      // Performance logging is currently available on Chromium targets only.
    }
  }

  private async responseBody(browser: BrowserSession["active"], requestId: string): Promise<string | undefined> {
    try {
      const result = (await browser.devtools("Network.getResponseBody", { requestId })) as {
        body?: string;
        base64Encoded?: boolean;
      };
      if (!result.body) return undefined;
      const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
      return body.slice(0, TestbenchDefaults.PAGE_SOURCE_LIMIT);
    } catch {
      return undefined;
    }
  }

  private async appiumCommand<T = void>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.appium) throw new Error("This command requires an active mobile session.");
    try {
      return await new AppiumSessionClient(this.appium.port, this.session.active.sessionId).request<T>(
        path,
        "POST",
        body,
        TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`Appium command timed out after ${TestbenchDefaults.ANDROID_ADB_COMMAND_TIMEOUT_MS} ms.`);
      }
      throw error;
    }
  }

  private pushDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticEvents.push({
      ...event,
      ...(event.headers ? { headers: this.redactHeaders(event.headers) } : {}),
    });
    if (this.diagnosticEvents.length > TestbenchDefaults.DIAGNOSTIC_EVENT_LIMIT) {
      this.diagnosticEvents.splice(0, this.diagnosticEvents.length - TestbenchDefaults.DIAGNOSTIC_EVENT_LIMIT);
    }
  }

  private redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        /^(authorization|proxy-authorization|cookie|set-cookie)$/iu.test(name) ? "[REDACTED]" : value,
      ]),
    );
  }

  async close(): Promise<{ videoPath?: string }> {
    const target = this.target;
    const failures: unknown[] = [];
    let videoPath: string | undefined;
    if (this.video) {
      try {
        videoPath = (await this.stopRecording()).path;
      } catch (error) {
        failures.push(error);
      }
    } else videoPath = this.lastRecording?.path;
    await this.resetOriginPermissions().catch((error) => failures.push(error));
    await this.androidPermissions?.restore().catch((error) => failures.push(error));
    const browserClose = (this.pendingBrowserClose ??= this.session.close());
    let browserCloseTimedOut = false;
    await this.withCleanupTimeout("browser session", browserClose).catch((error) => {
      if (error instanceof CleanupTimeoutError) browserCloseTimedOut = true;
      else failures.push(error);
    });
    if (!browserCloseTimedOut) this.pendingBrowserClose = undefined;
    await this.appium?.process.stop().catch((error) => failures.push(error));
    if (browserCloseTimedOut) {
      await this.withCleanupTimeout("browser session after stopping Appium", browserClose)
        .then(() => (this.pendingBrowserClose = undefined))
        .catch((error) => failures.push(error));
    }
    await IosSessionCleanup.run(target).catch((error) => failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, "Session cleanup failed.");
    this.clearState();
    return { videoPath };
  }

  private clearState(): void {
    this.video = undefined;
    this.lastRecording = undefined;
    this.appium = undefined;
    this.target = undefined;
    this.diagnosticEvents.length = 0;
    this.requestTimestamps.clear();
    this.webSocketUrls.clear();
    this.androidPermissions = undefined;
    this.originPermissions = [];
    this.pendingBrowserClose = undefined;
    this.permissionMetadata = undefined;
  }

  private async preparePermissions(
    target: TargetConfig,
    browser: BrowserSession["active"],
    requested: Array<{ name: "camera" | "microphone" | "geolocation" | "notifications"; origin: string }>,
  ): Promise<{ requested: typeof requested; confirmed: typeof requested; packageName?: string }> {
    let packageName: string | undefined;
    if (target.name === "chrome-android") {
      const native = requested
        .map((permission) => permission.name)
        .filter((name): name is "camera" | "microphone" => name === "camera" || name === "microphone");
      if (native.length) {
        this.androidPermissions = new AndroidCameraUtilities(target, browser.capabilities);
        packageName = (await this.androidPermissions.grant(native)).packageName;
      }
    }
    for (const permission of requested) {
      try {
        await this.setOriginPermission(target, browser, permission, "granted");
      } catch (error) {
        throw new TestbenchError("PERMISSION_DENIED", `Could not grant ${permission.name} for ${permission.origin}.`, {
          operation: "permission.origin",
          status: 403,
          cause: error,
          details: { platform: target.name, packageName, origin: permission.origin, permission: permission.name },
        });
      }
      this.originPermissions.push(permission);
    }
    return { requested, confirmed: [...requested], ...(packageName ? { packageName } : {}) };
  }

  private async resetOriginPermissions(): Promise<void> {
    if (!this.originPermissions.length) return;
    const browser = this.session.active;
    const results = await Promise.allSettled(
      this.originPermissions.map((permission) => this.setOriginPermission(this.target!, browser, permission, "prompt")),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Could not reset origin permissions.",
      );
  }

  private async setOriginPermission(
    target: TargetConfig,
    browser: BrowserSession["active"],
    permission: { name: string; origin: string },
    setting: "granted" | "denied" | "prompt",
  ): Promise<void> {
    if (target.name !== "chrome-android") {
      await browser.permission(permission.name, setting, permission.origin);
      return;
    }
    await this.appiumCommand("goog/cdp/execute", {
      cmd: "Browser.setPermission",
      params: { permission: { name: permission.name }, setting, origin: permission.origin },
    });
  }

  private async iosStartupDiagnostic(target: TargetConfig, error: unknown): Promise<string> {
    const appium = this.appium?.process;
    if (!appium || target.name !== "safari-ios" || target.deviceKind !== "physical") return appium?.recentOutput ?? "";
    if (IosPhysicalStartupError.isSafariDebuggerTimeout(error)) return appium.recentOutput;

    const deadline = Date.now() + TestbenchDefaults.IOS_STARTUP_DIAGNOSTIC_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const output = appium.recentOutput;
      if (IosPhysicalStartupError.hasTerminalDiagnostic(output)) return output;
      await new Promise((resolve) => setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS));
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
            () => reject(new CleanupTimeoutError(`Timed out while closing the ${label}.`)),
            TestbenchDefaults.REMOTE_CLEANUP_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
