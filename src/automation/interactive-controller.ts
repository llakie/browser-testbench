import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StartSessionInput } from "../config/input-schemas.js";
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

export class InteractiveController {
  private readonly session = new BrowserSession();
  private appium?: { process: ManagedProcess; port: number };
  private target?: TargetConfig;

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

  async source(maxCharacters = 100_000): Promise<string> {
    return (await this.session.active.getPageSource()).slice(0, maxCharacters);
  }

  async gesture(input: GestureRequest): Promise<GestureExecution> {
    if (!this.target) throw new Error("No interactive target is active.");
    return MobileGestures.perform(this.session.active, this.target, input);
  }

  async close(): Promise<void> {
    await this.session.close().catch(() => undefined);
    await this.appium?.process.stop().catch(() => undefined);
    this.appium = undefined;
    this.target = undefined;
  }
}
