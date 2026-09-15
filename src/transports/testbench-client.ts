import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiagnosticEvent, PageInspection } from "../automation/interactive-controller.js";
import type { GestureExecution } from "../automation/mobile-gestures.js";
import { InputSchemas, type GestureRequest, type StartSessionInput } from "../config/input-schemas.js";
import type { DoctorCheck, TargetConfig, TargetDefinition, TargetName } from "../config/types.js";

export interface RemoteTestbenchConfig {
  server: string;
  token?: string;
  targetPolicy?: "available" | "strict";
  targets?: Array<TargetName | TargetConfig>;
}

export interface TestbenchCapabilities {
  platform: NodeJS.Platform;
  architecture: string;
  targets: Array<TargetDefinition & { check?: DoctorCheck }>;
  checks: DoctorCheck[];
}

interface StartedSession {
  id: string;
  target: StartSessionInput["target"];
  createdAt: string;
  runtime: Record<string, unknown>;
}

export class RemoteTestbench {
  private readonly server: string;

  constructor(private readonly config: RemoteTestbenchConfig) {
    this.server = config.server.replace(/\/$/, "");
  }

  async capabilities(): Promise<TestbenchCapabilities> {
    return this.request<TestbenchCapabilities>("/v1/capabilities");
  }

  async availableTargets(): Promise<TargetConfig[]> {
    const configured = (this.config.targets ?? []).map((target) =>
      typeof target === "string" ? { name: target } : target,
    );
    const capabilities = await this.capabilities();
    const checks = new Map(capabilities.checks.map((check) => [check.id, check]));
    const available = configured.filter((target) => checks.get(target.name)?.status === "ready");
    if ((this.config.targetPolicy ?? "available") === "strict" && available.length !== configured.length) {
      const unavailable = configured.filter((target) => !available.includes(target)).map((target) => target.name);
      throw new Error(`Configured targets are not ready: ${unavailable.join(", ")}`);
    }
    return available;
  }

  async open(options: StartSessionInput): Promise<RemoteSession> {
    const configured = this.config.targets
      ?.map((target) => (typeof target === "string" ? { name: target } : target))
      .find((target) => target.name === options.target);
    const input = InputSchemas.startSession.parse({ ...configured, ...options });
    const started = await this.request<StartedSession>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return new RemoteSession(this, started);
  }

  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.server}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(
        `Browser Testbench is not reachable at ${this.server}: ${error instanceof Error ? error.message : error}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Browser Testbench responded with HTTP ${response.status}.`);
    return payload;
  }
}

export class RemoteSession {
  readonly id: string;
  readonly target: StartSessionInput["target"];
  readonly runtime: Record<string, unknown>;

  constructor(
    private readonly testbench: RemoteTestbench,
    started: StartedSession,
  ) {
    this.id = started.id;
    this.target = started.target;
    this.runtime = started.runtime;
  }

  navigate(url: string): Promise<PageInspection> {
    return this.post("navigate", { url });
  }

  inspect(limit = 100): Promise<PageInspection> {
    return this.testbench.request(`/v1/sessions/${this.id}/inspect?limit=${limit}`);
  }

  async click(selector: string): Promise<void> {
    await this.post("click", { selector });
  }

  async type(selector: string, value: string, clear = true): Promise<void> {
    await this.post("type", { selector, value, clear });
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

  async waitForElement(selector: string, timeoutMs = 15_000): Promise<void> {
    await this.post("wait", { type: "element", selector, timeoutMs });
  }

  async waitForText(text: string, timeoutMs = 15_000): Promise<void> {
    await this.post("wait", { type: "text", text, timeoutMs });
  }

  async waitForUrl(value: string, timeoutMs = 15_000): Promise<void> {
    await this.post("wait", { type: "url", value, timeoutMs });
  }

  diagnostics(): Promise<DiagnosticEvent[]> {
    return this.testbench.request(`/v1/sessions/${this.id}/diagnostics`);
  }

  devtools(): Promise<Record<string, unknown>> {
    return this.testbench.request(`/v1/sessions/${this.id}/devtools`);
  }

  async screenshotBase64(): Promise<string> {
    const result = await this.post<{ base64: string }>("screenshot", {});
    return result.base64;
  }

  async screenshot(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await this.screenshotBase64(), "base64"));
    return path;
  }

  async close(): Promise<void> {
    await this.testbench.request(`/v1/sessions/${this.id}`, { method: "DELETE" });
  }

  private gesture(input: GestureRequest): Promise<GestureExecution> {
    return this.post("gesture", input);
  }

  private post<T = unknown>(action: string, body: unknown): Promise<T> {
    return this.testbench.request(`/v1/sessions/${this.id}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
