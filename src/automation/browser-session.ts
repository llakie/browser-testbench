import { Builder, By, until, type WebDriver, type WebElement } from "selenium-webdriver";
import { writeFile } from "node:fs/promises";
import { TargetRegistry } from "../config/target-registry.js";
import type { TargetConfig } from "../config/types.js";

export class BrowserElement {
  constructor(
    private readonly driver: WebDriver,
    private readonly selector: By,
  ) {}

  private element(): Promise<WebElement> {
    return this.driver.findElement(this.selector);
  }

  async click(): Promise<void> {
    await (await this.element()).click();
  }

  async clearValue(): Promise<void> {
    await (await this.element()).clear();
  }

  async setValue(value: string): Promise<void> {
    const element = await this.element();
    await element.clear();
    await element.sendKeys(value);
  }

  async getText(): Promise<string> {
    return (await this.element()).getText();
  }

  async waitForDisplayed(options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 15_000;
    const element = await this.driver.wait(until.elementLocated(this.selector), timeout);
    await this.driver.wait(until.elementIsVisible(element), timeout);
  }

  async waitForClickable(options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 15_000;
    const element = await this.driver.wait(until.elementLocated(this.selector), timeout);
    await this.driver.wait(until.elementIsVisible(element), timeout);
    await this.driver.wait(until.elementIsEnabled(element), timeout);
  }
}

export class BrowserHandle {
  private constructor(
    private readonly driver: WebDriver,
    readonly sessionId: string,
    readonly capabilities: Record<string, unknown>,
  ) {}

  static async create(capabilities: Record<string, unknown>, serverUrl?: string): Promise<BrowserHandle> {
    let builder = new Builder().withCapabilities(capabilities);
    if (serverUrl) builder = builder.usingServer(serverUrl);
    const driver = await builder.build();
    const session = await driver.getSession();
    const returnedCapabilities = await driver.getCapabilities();
    const runtime = Object.fromEntries(
      [...returnedCapabilities.keys()].map((key) => [key, returnedCapabilities.get(key)]),
    );
    return new BrowserHandle(driver, session.getId(), runtime);
  }

  async url(value: string): Promise<void> {
    await this.driver.get(value);
  }

  async getUrl(): Promise<string> {
    return this.driver.getCurrentUrl();
  }

  async getTitle(): Promise<string> {
    return this.driver.getTitle();
  }

  async getPageSource(): Promise<string> {
    return this.driver.getPageSource();
  }

  async takeScreenshot(): Promise<string> {
    return this.driver.takeScreenshot();
  }

  async saveScreenshot(path: string): Promise<void> {
    await writeFile(path, Buffer.from(await this.takeScreenshot(), "base64"));
  }

  async execute<T>(script: string | ((...args: never[]) => T), ...args: unknown[]): Promise<T> {
    return this.driver.executeScript(script as string, ...args) as Promise<T>;
  }

  $(selector: string): BrowserElement {
    return new BrowserElement(this.driver, SelectorParser.parse(selector));
  }

  async deleteSession(): Promise<void> {
    await this.driver.quit();
  }

  async browserLogs(): Promise<unknown> {
    return this.driver.manage().logs().get("browser");
  }

  async logs(type: "browser" | "performance"): Promise<unknown[]> {
    return this.driver.manage().logs().get(type);
  }

  async waitForElement(selector: string, timeoutMs: number): Promise<void> {
    const element = await this.driver.wait(until.elementLocated(SelectorParser.parse(selector)), timeoutMs);
    await this.driver.wait(until.elementIsVisible(element), timeoutMs);
  }

  async waitForText(text: string, timeoutMs: number): Promise<void> {
    await this.driver.wait(
      async () => this.execute<boolean>("return (document.body?.innerText ?? '').includes(arguments[0])", text),
      timeoutMs,
    );
  }

  async waitForUrl(value: string, timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => (await this.getUrl()).includes(value), timeoutMs);
  }

  async getWindowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.driver.manage().window().getRect();
  }

  async setWindowRect(width: number, height: number): Promise<void> {
    await this.driver.manage().window().setRect({ width, height });
  }
}

export class SelectorParser {
  static parse(selector: string): By {
    if (selector.startsWith("//") || selector.startsWith("(")) return By.xpath(selector);
    if (selector.startsWith("~")) return By.css(`[aria-label=${JSON.stringify(selector.slice(1))}]`);
    const textSelector = selector.match(/^([a-zA-Z][\w-]*)=(.+)$/s);
    if (textSelector?.[1] && textSelector[2]) {
      const tag = textSelector[1];
      return By.xpath(`//${tag}[normalize-space(.)=${this.xpathLiteral(textSelector[2])}]`);
    }
    return By.css(selector);
  }

  private static xpathLiteral(value: string): string {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    return `concat(${value
      .split("'")
      .map((part) => `'${part}'`)
      .join(', "\'", ')})`;
  }
}

export class BrowserSession {
  private browser?: BrowserHandle;

  get active(): BrowserHandle {
    if (!this.browser) throw new Error("No browser session is active.");
    return this.browser;
  }

  async start(
    target: TargetConfig,
    options: { appiumPort?: number; logLevel?: "silent" | "error" | "warn" | "info" } = {},
  ): Promise<BrowserHandle> {
    if (this.browser) await this.close();
    const isMobile = TargetRegistry.definitions[target.name].kind === "mobile";
    const serverUrl = isMobile ? `http://127.0.0.1:${options.appiumPort}` : undefined;
    this.browser = await BrowserHandle.create(TargetRegistry.capabilities(target), serverUrl);
    return this.browser;
  }

  async navigate(url: string): Promise<void> {
    await this.active.url(url);
  }

  async close(): Promise<void> {
    const current = this.browser;
    this.browser = undefined;
    if (current) await current.deleteSession();
  }

  static urlForTarget(url: string, target: TargetConfig): string {
    if (target.name !== "chrome-android") return url;
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") parsed.hostname = "10.0.2.2";
    return parsed.toString();
  }
}
