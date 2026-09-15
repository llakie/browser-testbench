import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InputSchemas, type StartSessionInput, type WaitRequest } from "../config/input-schemas.js";
import type { GestureRequest } from "../config/input-schemas.js";
import { TargetRegistry } from "../config/target-registry.js";
import type { TargetConfig } from "../config/types.js";
import { ServiceManager, type ManagedProcess } from "../infrastructure/process-manager.js";
import { BrowserSession } from "./browser-session.js";
import { MobileGestures, type GestureExecution } from "./mobile-gestures.js";

export interface PageInspection {
  url: string;
  title: string;
  elements: Array<{ tag: string; role?: string; text?: string; label?: string; selector?: string }>;
}

export interface DiagnosticEvent {
  type: "console" | "request" | "response";
  timestamp: string;
  level?: string;
  message?: string;
  method?: string;
  url?: string;
  status?: number;
  mimeType?: string;
}

export class InteractiveController {
  private readonly session = new BrowserSession();
  private appium?: { process: ManagedProcess; port: number };
  private target?: TargetConfig;
  private readonly diagnosticEvents: DiagnosticEvent[] = [];

  async start(options: StartSessionInput): Promise<Record<string, unknown>> {
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
      capabilities: options.capabilities,
    };
    this.target = target;
    try {
      if (TargetRegistry.definitions[options.target].kind === "mobile")
        this.appium = await ServiceManager.startAppium();
      const browser = await this.session.start(target, { appiumPort: this.appium?.port });
      if (options.url) await this.session.navigate(BrowserSession.urlForTarget(options.url, target));
      return {
        target: options.target,
        sessionId: browser.sessionId,
        capabilities: browser.capabilities,
        url: options.url ? await browser.getUrl() : undefined,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async navigate(url: string): Promise<PageInspection> {
    if (!this.target) throw new Error("No interactive target is active.");
    await this.session.navigate(BrowserSession.urlForTarget(url, this.target));
    return this.inspect();
  }

  async inspect(limit = 100): Promise<PageInspection> {
    const browser = this.session.active;
    const elements = await browser.execute((maxItems: number) => {
      const selector = "a,button,input,textarea,select,[role],[contenteditable='true'],h1,h2,h3";
      return Array.from(document.querySelectorAll<HTMLElement>(selector))
        .slice(0, maxItems)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") ?? undefined,
          text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200) || undefined,
          label: element.getAttribute("aria-label") ?? element.getAttribute("name") ?? undefined,
          selector: element.id ? `#${CSS.escape(element.id)}` : undefined,
        }));
    }, limit);
    return {
      url: await browser.getUrl(),
      title: await browser.getTitle(),
      elements: elements as PageInspection["elements"],
    };
  }

  async click(selector: string): Promise<void> {
    const element = await this.session.active.$(selector);
    await element.waitForClickable({ timeout: 15_000 });
    await element.click();
  }

  async type(selector: string, value: string, clear = true): Promise<void> {
    const element = await this.session.active.$(selector);
    await element.waitForDisplayed({ timeout: 15_000 });
    if (clear) await element.clearValue();
    await element.setValue(value);
  }

  async screenshot(path?: string): Promise<{ path: string; base64: string }> {
    const output = path ?? join(process.cwd(), "artifacts", "interactive", `screenshot-${Date.now()}.png`);
    await mkdir(dirname(output), { recursive: true });
    const base64 = await this.session.active.takeScreenshot();
    await writeFile(output, Buffer.from(base64, "base64"));
    return { path: output, base64 };
  }

  async captureScreenshot(): Promise<string> {
    return this.session.active.takeScreenshot();
  }

  async source(maxCharacters = 100_000): Promise<string> {
    return (await this.session.active.getPageSource()).slice(0, maxCharacters);
  }

  async gesture(input: GestureRequest): Promise<GestureExecution> {
    if (!this.target) throw new Error("No interactive target is active.");
    return MobileGestures.perform(this.session.active, this.target, input);
  }

  async wait(input: WaitRequest): Promise<void> {
    const request = InputSchemas.wait.parse(input);
    if (request.type === "element") await this.session.active.waitForElement(request.selector, request.timeoutMs);
    if (request.type === "text") await this.session.active.waitForText(request.text, request.timeoutMs);
    if (request.type === "url") await this.session.active.waitForUrl(request.value, request.timeoutMs);
  }

  async diagnostics(): Promise<DiagnosticEvent[]> {
    await this.collectDiagnostics();
    return [...this.diagnosticEvents];
  }

  debugTools(): Record<string, unknown> {
    if (!this.target) throw new Error("No interactive target is active.");
    if (this.target.name === "safari-ios") {
      return {
        tool: "Safari Web Inspector",
        automatic: false,
        steps: [
          "Open Safari on the Mac and enable Develop menu in Safari Settings > Advanced.",
          "Open Develop and select the iOS Simulator and its current page.",
        ],
      };
    }
    if (this.target.name === "chrome-android") {
      return { tool: "Chrome DevTools", automatic: false, url: "chrome://inspect/#devices" };
    }
    return {
      tool: "Testbench diagnostics",
      automatic: true,
      detail: "Console output and HTTP requests/responses are available through the diagnostics endpoint.",
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
          const request = message.params?.request as { method?: string; url?: string } | undefined;
          this.pushDiagnostic({
            type: "request",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            method: request?.method,
            url: request?.url,
          });
        }
        if (message?.method === "Network.responseReceived") {
          const response = message.params?.response as { status?: number; url?: string; mimeType?: string } | undefined;
          this.pushDiagnostic({
            type: "response",
            timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
            status: response?.status,
            url: response?.url,
            mimeType: response?.mimeType,
          });
        }
      }
    } catch {
      // Performance logging is currently available on Chromium targets only.
    }
  }

  private pushDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticEvents.push(event);
    if (this.diagnosticEvents.length > 500) this.diagnosticEvents.splice(0, this.diagnosticEvents.length - 500);
  }

  async close(): Promise<void> {
    await this.session.close().catch(() => undefined);
    await this.appium?.process.stop().catch(() => undefined);
    this.appium = undefined;
    this.target = undefined;
    this.diagnosticEvents.length = 0;
  }
}
