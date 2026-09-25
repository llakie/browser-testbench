import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { TestbenchDefaults } from "../config/defaults.js";
import { TargetRegistry } from "../config/target-registry.js";
import {
  BrowserOrientation,
  PinchDirection,
  SwipeDirection,
  type BrowserOrientationValue,
} from "../config/interaction-values.js";
import type { DiagnosticEvent, PageInspection } from "../automation/interactive-controller.js";
import type { GestureExecution } from "../automation/mobile-gestures.js";
import {
  InputSchemas,
  type BrowserActionRequest,
  type ElementActionRequest,
  type GestureRequest,
  type StartSessionInput,
  type WaitRequest,
} from "../config/input-schemas.js";
import type { DoctorCheck, TargetDefinition, TestTargetInfo, VerificationResult } from "../config/types.js";
import type { ConnectionStatus, PairingRequired, RemoteInstance, RemoteRole } from "../remote/remote-types.js";
import type { SetupAction } from "../setup/setup-types.js";
import { ClientVersion } from "../config/client-version.js";
import { ErrorResponse, type ErrorResponsePayload } from "../i18n/error-response.js";
import { TestbenchError } from "../errors/testbench-error.js";
import type { AssetReference } from "../automation/session-asset-manager.js";
import type { SessionMark } from "../automation/session-manager.js";
import {
  TargetCapabilityService,
  type CapabilityRequirement,
  type FeatureCapabilities,
} from "../setup/target-capability-service.js";

export { TestbenchError } from "../errors/testbench-error.js";

export type { SetupAction } from "../setup/setup-types.js";

export type { PairingRequired } from "../remote/remote-types.js";

export { BrowserOrientation, PinchDirection, SwipeDirection };
export type {
  BrowserOrientationValue,
  PinchDirectionValue,
  SwipeDirectionValue,
} from "../config/interaction-values.js";

export interface RemoteTestbenchOptions {
  server?: string;
  token?: string;
  requestTimeoutMs?: number;
}

export interface TestbenchRequestInit extends RequestInit {
  timeoutMs?: number;
  duplex?: "half";
}

export interface AssetUploadOptions {
  name?: string;
  contentType?: string;
  signal?: AbortSignal;
}

export type AssetSource = string | Buffer | Uint8Array;

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TestbenchCapabilities {
  platform: NodeJS.Platform;
  architecture: string;
  targets: Array<TargetDefinition & { check?: DoctorCheck }>;
  checks: DoctorCheck[];
  testTargets: Array<TestTargetInfo & { capabilities: FeatureCapabilities }>;
  limits: FeatureCapabilities["limits"];
}

export interface ElementState {
  tag: string;
  text: string;
  value: string | null;
  visible: boolean;
  enabled: boolean;
  selected: boolean;
  focused: boolean;
  rect: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;
}

export interface BrowserStateSnapshot {
  cookies: Array<{
    name: string;
    value: string;
    path?: string;
    domain?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    expiry?: number;
  }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

interface StartedSession {
  id: string;
  target: StartSessionInput["target"];
  createdAt: string;
  runtime: Record<string, unknown>;
  leaseTimeoutMs?: number;
  leaseExpiresAt?: string;
}

export class RemoteTestbench {
  private readonly server: string;
  readonly assets: RemoteAssetCollection;

  constructor(private readonly options: RemoteTestbenchOptions = {}) {
    this.server = (options.server ?? process.env.BROWSER_TESTBENCH_URL ?? TestbenchDefaults.SERVER_URL).replace(
      /\/$/,
      "",
    );
    this.assets = new RemoteAssetCollection(this);
  }

  async capabilities(): Promise<TestbenchCapabilities> {
    return this.request<TestbenchCapabilities>("/v1/capabilities");
  }

  async targets(): Promise<TestTargetInfo[]> {
    return this.request<TestTargetInfo[]>("/v1/targets");
  }

  async target(id: string): Promise<RemoteTarget> {
    const target = (await this.capabilities()).testTargets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`Browser Testbench target '${id}' was not found.`);
    return new RemoteTarget(target);
  }

  async doctor(targets?: string[]): Promise<DoctorCheck[]> {
    const checks = (await this.capabilities()).checks;
    if (!targets) return checks;
    const requested = new Set(targets);
    return checks.filter((check) => requested.has(check.id));
  }

  setup(targets: string[]): Promise<SetupAction[]> {
    return this.request("/v1/workbench/setup", {
      method: "POST",
      body: JSON.stringify({ targets }),
      timeoutMs: TestbenchDefaults.SETUP_REQUEST_TIMEOUT_MS,
    });
  }

  planSetup(targets: string[]): Promise<SetupAction[]> {
    return this.request("/v1/workbench/plan", {
      method: "POST",
      body: JSON.stringify({ targets }),
    });
  }

  connection(): Promise<ConnectionStatus> {
    return this.request("/v1/connections/status");
  }

  discoverTestbenches(): Promise<RemoteInstance[]> {
    return this.request("/v1/connections/discover");
  }

  remoteIdentity(server: string): Promise<RemoteInstance> {
    return this.request(`/v1/connections/identity?server=${encodeURIComponent(server)}`);
  }

  connectTestbench(
    instance: RemoteInstance,
    role: RemoteRole = "control",
  ): Promise<ConnectionStatus | PairingRequired> {
    return this.request("/v1/connections/connect", {
      method: "POST",
      body: JSON.stringify({ instance, role }),
    });
  }

  completePairing(pairingId: string, code: string): Promise<ConnectionStatus> {
    return this.request("/v1/connections/pair", {
      method: "POST",
      body: JSON.stringify({ pairingId, code }),
    });
  }

  disconnectTestbench(): Promise<ConnectionStatus> {
    return this.request("/v1/connections/active", { method: "DELETE" });
  }

  async availableTargets(requested?: string[]): Promise<string[]> {
    const targets = await this.targets();
    const ready = new Set(targets.filter((target) => target.ready).map((target) => target.id));
    const available = requested ? requested.filter((target) => ready.has(target)) : [...ready];
    if (available.length === 0) {
      const selection = requested?.length ? ` Requested: ${requested.join(", ")}.` : "";
      throw new Error(`None of the requested Browser Testbench targets are ready.${selection}`);
    }
    return available;
  }

  async open(options: StartSessionInput): Promise<RemoteSession> {
    const input = InputSchemas.startSession.parse(options);
    const started = await this.request<StartedSession>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
      ...(TargetRegistry.isMobileTargetId(input.target)
        ? { timeoutMs: TestbenchDefaults.MOBILE_SESSION_REQUEST_TIMEOUT_MS }
        : {}),
    });
    return new RemoteSession(this, started);
  }

  async sessions(): Promise<RemoteSession[]> {
    const sessions = await this.request<StartedSession[]>("/v1/sessions");
    return sessions.map((session) => new RemoteSession(this, session));
  }

  closeSession(id: string): Promise<{ closed: true; videoPath?: string }> {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  uploadAsset(source: AssetSource, options: AssetUploadOptions = {}, sessionId?: string): Promise<AssetReference> {
    return RemoteAssetCollection.upload(
      this,
      sessionId ? `/v1/sessions/${sessionId}/assets` : "/v1/assets",
      source,
      options,
    );
  }

  verify(target: string, options: { headless?: boolean } = {}): Promise<VerificationResult> {
    return this.request<VerificationResult>("/v1/verify", {
      method: "POST",
      body: JSON.stringify({ target, ...options }),
      ...(TargetRegistry.isMobileTargetId(target)
        ? { timeoutMs: TestbenchDefaults.MOBILE_SESSION_REQUEST_TIMEOUT_MS }
        : {}),
    });
  }

  async forEachTarget<T>(
    requested: string[],
    options: Omit<StartSessionInput, "target">,
    run: (session: RemoteSession, target: string) => Promise<T>,
  ): Promise<Array<{ target: string; result: T }>> {
    const targets = await this.availableTargets(requested);
    return Promise.all(
      targets.map(async (target) => {
        const session = await this.open({ ...options, target });
        try {
          return { target, result: await run(session, target) };
        } finally {
          await session.close();
        }
      }),
    );
  }

  async request<T = unknown>(path: string, init: TestbenchRequestInit = {}): Promise<T> {
    const { timeoutMs = this.options.requestTimeoutMs ?? TestbenchDefaults.REMOTE_REQUEST_TIMEOUT_MS, ...requestInit } =
      init;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal =
      requestInit.signal && timeoutSignal
        ? AbortSignal.any([requestInit.signal, timeoutSignal])
        : (requestInit.signal ?? timeoutSignal);
    let response: Response;
    try {
      response = await fetch(`${this.server}${path}`, {
        ...requestInit,
        signal,
        headers: {
          ...(requestInit.body ? { "content-type": "application/json" } : {}),
          [ClientVersion.HEADER]: ClientVersion.CURRENT,
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
          ...requestInit.headers,
        },
      });
    } catch (error) {
      if (timeoutSignal?.aborted)
        throw new Error(`Browser Testbench at ${this.server} timed out after ${timeoutMs} ms.`);
      if (requestInit.signal?.aborted)
        throw new TestbenchError("OPERATION_ABORTED", `Request to ${path} was aborted.`, {
          operation: RemoteTestbench.operation(path),
          status: 499,
        });
      throw new Error(
        `Browser Testbench is not reachable at ${this.server}: ${error instanceof Error ? error.message : error}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as T & ErrorResponsePayload;
    if (!response.ok) {
      const message = ErrorResponse.message(payload, `Browser Testbench responded with HTTP ${response.status}.`);
      if (payload.code && payload.operation) {
        throw new TestbenchError(payload.code, message, {
          operation: payload.operation,
          sessionId: payload.sessionId,
          details: payload.details,
          status: response.status,
        });
      }
      throw new Error(message);
    }
    return payload;
  }

  private static operation(path: string): string {
    return path.endsWith("/wait") ? "wait" : path.endsWith("/navigate") ? "navigate" : "request";
  }
}

export class RemoteTarget {
  readonly id: string;
  readonly capabilities: FeatureCapabilities;

  constructor(readonly info: TestTargetInfo & { capabilities: FeatureCapabilities }) {
    this.id = info.id;
    this.capabilities = info.capabilities;
  }

  require(requirement: CapabilityRequirement): this {
    const missing = TargetCapabilityService.missing(requirement, this.capabilities);
    if (missing.length)
      throw new TestbenchError(
        "CAPABILITY_UNAVAILABLE",
        `Target '${this.id}' does not provide required capabilities.`,
        {
          operation: "capability.require",
          status: 409,
          details: { target: this.id, requested: requirement, available: this.capabilities, missing },
        },
      );
    return this;
  }
}

export class RemoteAssetCollection {
  constructor(
    private readonly testbench: RemoteTestbench,
    private readonly sessionId?: string,
  ) {}

  upload(source: AssetSource, options: AssetUploadOptions = {}): Promise<AssetReference> {
    return this.testbench.uploadAsset(source, options, this.sessionId);
  }

  static async upload(
    testbench: RemoteTestbench,
    path: string,
    source: AssetSource,
    options: AssetUploadOptions,
  ): Promise<AssetReference> {
    const prepared = await this.prepare(source, options);
    return testbench.request<AssetReference>(path, {
      method: "POST",
      body: prepared.body,
      duplex: "half",
      signal: options.signal,
      timeoutMs: Math.max(
        TestbenchDefaults.REMOTE_REQUEST_TIMEOUT_MS,
        TestbenchDefaults.ASSET_UPLOAD_REQUEST_TIMEOUT_MS,
      ),
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(prepared.size),
        "x-browser-testbench-asset-name": encodeURIComponent(prepared.name),
        "x-browser-testbench-asset-size": String(prepared.size),
        "x-browser-testbench-asset-sha256": prepared.sha256,
        "x-browser-testbench-asset-content-type": options.contentType ?? "application/octet-stream",
      },
    });
  }

  private static async prepare(
    source: AssetSource,
    options: AssetUploadOptions,
  ): Promise<{ body: BodyInit; name: string; size: number; sha256: string }> {
    if (typeof source !== "string") {
      const buffer = Buffer.from(source);
      return {
        body: buffer,
        name: options.name ?? "asset.bin",
        size: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    }
    const information = await stat(source);
    if (!information.isFile()) throw new Error(`Asset source is not a file: ${source}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) hash.update(chunk as Buffer);
    return {
      body: Readable.toWeb(createReadStream(source)) as BodyInit,
      name: options.name ?? basename(source),
      size: information.size,
      sha256: hash.digest("hex"),
    };
  }
}

export class RemoteSession {
  readonly id: string;
  readonly target: StartSessionInput["target"];
  readonly runtime: Record<string, unknown>;
  readonly leaseTimeoutMs: number;
  readonly assets: RemoteAssetCollection;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closeResult?: Promise<{ closed: true; videoPath?: string }>;

  constructor(
    private readonly testbench: RemoteTestbench,
    started: StartedSession,
  ) {
    this.id = started.id;
    this.target = started.target;
    this.runtime = started.runtime;
    this.leaseTimeoutMs = started.leaseTimeoutMs ?? TestbenchDefaults.SESSION_LEASE_TIMEOUT_MS;
    this.assets = new RemoteAssetCollection(testbench, this.id);
    this.heartbeat = setInterval(
      () => void this.renewLease(),
      Math.min(TestbenchDefaults.SESSION_HEARTBEAT_INTERVAL_MS, Math.max(1_000, Math.floor(this.leaseTimeoutMs / 3))),
    );
    this.heartbeat.unref();
  }

  navigate(url: string): Promise<PageInspection> {
    return this.post("navigate", { url });
  }

  inspect(limit = TestbenchDefaults.INSPECTION_LIMIT): Promise<PageInspection> {
    return this.testbench.request(`/v1/sessions/${this.id}/inspect?limit=${limit}`);
  }

  async url(): Promise<string> {
    return (await this.inspect(1)).url;
  }

  async title(): Promise<string> {
    return (await this.inspect(1)).title;
  }

  async click(selector: string): Promise<void> {
    await this.post("click", { selector });
  }

  async type(selector: string, value: string, clear = true): Promise<void> {
    await this.post("type", { selector, value, clear });
  }

  state(selector: string): Promise<ElementState> {
    return this.element<ElementState>({ action: "state", selector });
  }

  count(selector: string): Promise<number> {
    return this.element<number>({ action: "count", selector });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.element({ action: "fill", selector, value });
  }

  async append(selector: string, value: string): Promise<void> {
    await this.element({ action: "type", selector, value });
  }

  async clear(selector: string): Promise<void> {
    await this.element({ action: "clear", selector });
  }

  async check(selector: string): Promise<void> {
    await this.element({ action: "check", selector });
  }

  async uncheck(selector: string): Promise<void> {
    await this.element({ action: "uncheck", selector });
  }

  async select(selector: string, values: string | string[], by: "value" | "text" | "index" = "value"): Promise<void> {
    await this.element({ action: "select", selector, values: Array.isArray(values) ? values : [values], by });
  }

  async upload(selector: string, paths: string | string[]): Promise<void> {
    await this.element({ action: "upload", selector, paths: Array.isArray(paths) ? paths : [paths] });
  }

  async focus(selector: string): Promise<void> {
    await this.element({ action: "focus", selector });
  }

  async blur(selector: string): Promise<void> {
    await this.element({ action: "blur", selector });
  }

  async submit(selector: string): Promise<void> {
    await this.element({ action: "submit", selector });
  }

  async press(keys: string | string[], selector?: string): Promise<void> {
    await this.element({ action: "press", selector, keys: Array.isArray(keys) ? keys : [keys] });
  }

  async hover(selector: string): Promise<void> {
    await this.element({ action: "hover", selector });
  }

  async doubleClick(selector: string): Promise<void> {
    await this.element({ action: "doubleClick", selector });
  }

  async rightClick(selector: string): Promise<void> {
    await this.element({ action: "rightClick", selector });
  }

  async drag(source: string, target: string): Promise<void> {
    await this.element({ action: "drag", selector: source, target });
  }

  async scrollIntoView(selector: string): Promise<void> {
    await this.element({ action: "scrollIntoView", selector });
  }

  async elementScreenshotBase64(selector: string): Promise<string> {
    const result = await this.element<{ base64: string }>({ action: "screenshot", selector });
    return result.base64;
  }

  async elementScreenshot(selector: string, path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await this.elementScreenshotBase64(selector), "base64"));
    return path;
  }

  tap(x: number, y: number): Promise<GestureExecution> {
    return this.gesture({ type: "tap", x, y });
  }

  swipe(input: Omit<Extract<GestureRequest, { type: "swipe" }>, "type">): Promise<GestureExecution> {
    return this.gesture({ type: "swipe", ...input });
  }

  pinch(input: Omit<Extract<GestureRequest, { type: "pinch" }>, "type">): Promise<GestureExecution> {
    return this.gesture({ type: "pinch", ...input });
  }

  async waitForElement(
    selector: string,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "element", selector, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForText(text: string, timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "text", text, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForUrl(value: string, timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "url", value, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForState(
    selector: string,
    state: "visible" | "hidden" | "present" | "absent" | "enabled" | "disabled" | "checked" | "unchecked",
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "state", selector, state, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForValue(
    selector: string,
    value: string,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "value", selector, value, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForCount(
    selector: string,
    count: number,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "count", selector, count, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForAttribute(
    selector: string,
    name: string,
    value?: string,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "attribute", selector, name, value, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForElementText(
    selector: string,
    text: string,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "elementText", selector, text, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForWindowCount(
    count: number,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "windowCount", count, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForNetworkIdle(
    quietMs = TestbenchDefaults.NETWORK_IDLE_QUIET_MS,
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "networkIdle", quietMs, timeoutMs: options.timeoutMs }, options.signal);
  }

  async waitForScript(
    script: string,
    arguments_: unknown[] = [],
    timeout: number | WaitOptions = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const options = RemoteSession.waitOptions(timeout);
    await this.wait({ type: "script", script, arguments: arguments_, timeoutMs: options.timeoutMs }, options.signal);
  }

  async back(): Promise<void> {
    await this.browser({ action: "back" });
  }

  async forward(): Promise<void> {
    await this.browser({ action: "forward" });
  }

  async refresh(): Promise<void> {
    await this.browser({ action: "refresh" });
  }

  async scroll(x: number, y: number): Promise<void> {
    await this.browser({ action: "scroll", x, y });
  }

  windows(): Promise<{ current: string; handles: string[] }> {
    return this.browser({ action: "windows" });
  }

  async newWindow(type: "tab" | "window" = "tab"): Promise<void> {
    await this.browser({ action: "newWindow", type });
  }

  async switchWindow(handle: string): Promise<void> {
    await this.browser({ action: "switchWindow", handle });
  }

  async closeWindow(): Promise<void> {
    await this.browser({ action: "closeWindow" });
  }

  async switchFrame(selector?: string): Promise<void> {
    await this.browser({ action: "frame", selector });
  }

  alert(behavior: "get" | "accept" | "dismiss", text?: string): Promise<{ text: string }> {
    return this.browser({ action: "alert", behavior, text });
  }

  cookies(): Promise<unknown[]> {
    return this.browser({ action: "cookies" });
  }

  accessibility(): Promise<unknown> {
    return this.browser({ action: "accessibility" });
  }

  async printPdf(path: string): Promise<string> {
    const result = (await this.browser({ action: "printPdf" })) as { data?: string } | string;
    const data = typeof result === "string" ? JSON.parse(result).data : result.data;
    if (!data) throw new Error("The browser did not return PDF data.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data, "base64"));
    return path;
  }

  async setCookie(cookie: BrowserStateSnapshot["cookies"][number]): Promise<void> {
    await this.browser({ action: "setCookie", cookie });
  }

  async deleteCookie(name?: string): Promise<void> {
    await this.browser({ action: "deleteCookie", name });
  }

  storage(area: "local" | "session"): Promise<Record<string, string>> {
    return this.browser({ action: "storage", area });
  }

  async setStorage(area: "local" | "session", key: string, value: string): Promise<void> {
    await this.browser({ action: "setStorage", area, key, value });
  }

  async deleteStorage(area: "local" | "session", key?: string): Promise<void> {
    await this.browser({ action: "deleteStorage", area, key });
  }

  async snapshotState(): Promise<BrowserStateSnapshot> {
    return {
      cookies: (await this.cookies()) as BrowserStateSnapshot["cookies"],
      localStorage: await this.storage("local"),
      sessionStorage: await this.storage("session"),
    };
  }

  async restoreState(snapshot: BrowserStateSnapshot): Promise<void> {
    await this.deleteCookie();
    for (const cookie of snapshot.cookies) {
      await this.setCookie({
        ...cookie,
      });
    }
    await this.deleteStorage("local");
    await this.deleteStorage("session");
    for (const [key, value] of Object.entries(snapshot.localStorage)) await this.setStorage("local", key, value);
    for (const [key, value] of Object.entries(snapshot.sessionStorage)) await this.setStorage("session", key, value);
  }

  async saveState(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(await this.snapshotState(), null, 2)}\n`);
    return path;
  }

  async loadState(path: string): Promise<void> {
    await this.restoreState(JSON.parse(await readFile(path, "utf8")) as BrowserStateSnapshot);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.browser({ action: "viewport", width, height });
  }

  waitForDownload(
    filename: string,
    timeoutMs = TestbenchDefaults.WAIT_TIMEOUT_MS,
  ): Promise<{ path: string; size: number }> {
    return this.browser({ action: "waitDownload", filename, timeoutMs });
  }

  evaluate<T = unknown>(script: string, arguments_: unknown[] = []): Promise<T> {
    return this.browser({ action: "evaluate", script, arguments: arguments_ });
  }

  async setNetworkConditions(options: {
    offline?: boolean;
    latencyMs?: number;
    downloadBytesPerSecond?: number;
    uploadBytesPerSecond?: number;
  }): Promise<void> {
    await this.browser({
      action: "network",
      offline: options.offline ?? false,
      latencyMs: options.latencyMs ?? 0,
      downloadBytesPerSecond: options.downloadBytesPerSecond ?? -1,
      uploadBytesPerSecond: options.uploadBytesPerSecond ?? -1,
    });
  }

  async setGeolocation(latitude: number, longitude: number, accuracy = 1): Promise<void> {
    await this.browser({ action: "geolocation", latitude, longitude, accuracy });
  }

  async setPermission(name: string, state: "granted" | "denied" | "prompt", origin?: string): Promise<void> {
    await this.browser({ action: "permission", name, state, origin });
  }

  async setOrientation(orientation: BrowserOrientationValue): Promise<void> {
    await this.browser({ action: "orientation", orientation });
  }

  async mobileBack(): Promise<void> {
    await this.browser({ action: "mobileBack" });
  }

  async hideKeyboard(): Promise<void> {
    await this.browser({ action: "hideKeyboard" });
  }

  async blockUrls(patterns: string[]): Promise<void> {
    await this.browser({ action: "blockUrls", patterns });
  }

  async writeClipboard(text: string): Promise<void> {
    await this.browser({ action: "clipboardWrite", text });
  }

  async readClipboard(): Promise<string> {
    return (await this.browser<{ text: string }>({ action: "clipboardRead" })).text;
  }

  async mockFetch(
    urlIncludes: string,
    response: { status?: number; headers?: Record<string, string>; body?: string },
  ): Promise<void> {
    await this.evaluate(
      `
        window.__browserTestbenchFetch ??= window.fetch.bind(window);
        window.__browserTestbenchMocks ??= [];
        window.__browserTestbenchMocks.push(arguments[0]);
        window.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          const mock = window.__browserTestbenchMocks.find(candidate => url.includes(candidate.urlIncludes));
          if (!mock) return window.__browserTestbenchFetch(input, init);
          return new Response(mock.body ?? "", { status: mock.status ?? 200, headers: mock.headers ?? {} });
        };
      `,
      [{ urlIncludes, ...response }],
    );
  }

  async clearFetchMocks(): Promise<void> {
    await this.evaluate(`
      if (window.__browserTestbenchFetch) window.fetch = window.__browserTestbenchFetch;
      delete window.__browserTestbenchFetch;
      delete window.__browserTestbenchMocks;
    `);
  }

  elementAction<T = unknown>(input: ElementActionRequest): Promise<T> {
    return this.post("element", input);
  }

  browserAction<T = unknown>(input: BrowserActionRequest): Promise<T> {
    return this.post("browser", input);
  }

  async wait(input: WaitRequest, signal?: AbortSignal): Promise<void> {
    await this.post(
      "wait",
      input,
      (input.timeoutMs ?? TestbenchDefaults.WAIT_TIMEOUT_MS) + TestbenchDefaults.REQUEST_TIMEOUT_GRACE_MS,
      signal,
    );
  }

  source(maxCharacters = TestbenchDefaults.PAGE_SOURCE_LIMIT): Promise<string> {
    return this.testbench.request(`/v1/sessions/${this.id}/source?maxCharacters=${maxCharacters}`);
  }

  diagnostics(): Promise<DiagnosticEvent[]> {
    return this.testbench.request(`/v1/sessions/${this.id}/diagnostics`);
  }

  async clearDiagnostics(): Promise<void> {
    await this.testbench.request(`/v1/sessions/${this.id}/diagnostics`, { method: "DELETE" });
  }

  devtools(): Promise<Record<string, unknown>> {
    return this.testbench.request(`/v1/sessions/${this.id}/devtools`);
  }

  async screenshotBase64(fullPage = false): Promise<string> {
    const result = await this.post<{ base64: string }>("screenshot", { fullPage });
    return result.base64;
  }

  async screenshot(path: string, fullPage = false): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await this.screenshotBase64(fullPage), "base64"));
    return path;
  }

  close(): Promise<{ closed: true; videoPath?: string }> {
    if (!this.closeResult) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.closeResult = this.testbench.closeSession(this.id);
    }
    return this.closeResult;
  }

  mark(name: string, data?: Record<string, unknown>): Promise<SessionMark> {
    return this.post("marks", { name, data });
  }

  private gesture(input: GestureRequest): Promise<GestureExecution> {
    return this.post("gesture", input);
  }

  private element<T = unknown>(input: ElementActionRequest): Promise<T> {
    return this.post("element", input);
  }

  private browser<T = unknown>(input: BrowserActionRequest): Promise<T> {
    const timeoutMs =
      input.action === "waitDownload"
        ? (input.timeoutMs ?? TestbenchDefaults.WAIT_TIMEOUT_MS) + TestbenchDefaults.REQUEST_TIMEOUT_GRACE_MS
        : undefined;
    return this.post("browser", input, timeoutMs);
  }

  private post<T = unknown>(action: string, body: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    return this.testbench.request(`/v1/sessions/${this.id}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal ? { signal } : {}),
    });
  }

  private static waitOptions(timeout: number | WaitOptions): Required<Pick<WaitOptions, "timeoutMs">> & WaitOptions {
    const options = typeof timeout === "number" ? { timeoutMs: timeout } : timeout;
    const timeoutMs = options.timeoutMs ?? TestbenchDefaults.WAIT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError("timeoutMs must be a positive finite number.");
    return { ...options, timeoutMs };
  }

  private async renewLease(): Promise<void> {
    try {
      await this.testbench.request(`/v1/sessions/${this.id}/lease`, { method: "POST" });
    } catch (error) {
      if (error instanceof TestbenchError && error.code === "SESSION_LEASE_EXPIRED") {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    }
  }
}
