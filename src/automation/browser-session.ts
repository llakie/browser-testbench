import { Builder, By, Key, type WebDriver, type WebElement } from "selenium-webdriver";
import { writeFile } from "node:fs/promises";
import { TestbenchDefaults } from "../config/defaults.js";
import { TargetRegistry } from "../config/target-registry.js";
import type { TargetConfig } from "../config/types.js";

export class BrowserElement {
  constructor(
    private readonly driver: WebDriver,
    private readonly selector: string,
  ) {}

  private element(): Promise<WebElement> {
    return this.driver.findElement(By.css(this.selector));
  }

  async click(): Promise<void> {
    await (await this.element()).click();
  }

  async clearValue(): Promise<void> {
    await (await this.element()).clear();
  }

  async setValue(value: string): Promise<void> {
    await (await this.element()).sendKeys(value);
  }

  async getText(): Promise<string> {
    return (await this.element()).getText();
  }

  async state(): Promise<Record<string, unknown>> {
    const element = await this.element();
    return {
      tag: await element.getTagName(),
      text: await element.getText(),
      value: await element.getAttribute("value"),
      visible: await element.isDisplayed(),
      enabled: await element.isEnabled(),
      selected: await element.isSelected(),
      rect: await element.getRect(),
      attributes: await this.driver.executeScript(
        "return Object.fromEntries([...arguments[0].attributes].map(attribute => [attribute.name, attribute.value]))",
        element,
      ),
      focused: await this.driver.executeScript("return document.activeElement === arguments[0]", element),
    };
  }

  async setChecked(checked: boolean): Promise<void> {
    const element = await this.element();
    if ((await element.isSelected()) !== checked) await element.click();
  }

  async select(values: string[], by: "value" | "text" | "index"): Promise<void> {
    await this.driver.executeScript(
      `
        const select = arguments[0];
        const values = arguments[1];
        const by = arguments[2];
        const matches = option => values.includes(
          by === "value" ? option.value : by === "text" ? option.text.trim() : String(option.index)
        );
        for (const option of select.options) option.selected = matches(option);
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
      `,
      await this.element(),
      values,
      by,
    );
  }

  async upload(paths: string[]): Promise<void> {
    await (await this.element()).sendKeys(paths.join("\n"));
  }

  async focus(): Promise<void> {
    await this.driver.executeScript("arguments[0].focus()", await this.element());
  }

  async blur(): Promise<void> {
    await this.driver.executeScript("arguments[0].blur()", await this.element());
  }

  async scrollIntoView(): Promise<void> {
    await this.driver.executeScript(
      'arguments[0].scrollIntoView({block:"center",inline:"center"})',
      await this.element(),
    );
  }

  async submit(): Promise<void> {
    await this.driver.executeScript(
      "const form = arguments[0].form ?? arguments[0].closest('form'); if (!form) throw new Error('Element is not associated with a form.'); form.requestSubmit ? form.requestSubmit() : form.submit();",
      await this.element(),
    );
  }

  async screenshot(): Promise<string> {
    return (await this.element()).takeScreenshot();
  }

  async waitForDisplayed(options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? TestbenchDefaults.WAIT_TIMEOUT_MS;
    await this.driver.wait(async () => {
      const [element] = await this.driver.findElements(By.css(this.selector));
      return element ? element.isDisplayed().catch(() => false) : false;
    }, timeout);
  }

  async waitForClickable(options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? TestbenchDefaults.WAIT_TIMEOUT_MS;
    await this.driver.wait(async () => {
      const element = await this.element().catch(() => undefined);
      return Boolean(element && (await element.isDisplayed()) && (await element.isEnabled()));
    }, timeout);
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

  async takeFullPageScreenshot(): Promise<string> {
    const original = await this.getWindowRect();
    const size = await this.execute<{ width: number; height: number }>(
      "return {width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)}",
    );
    try {
      await this.setWindowRect(Math.max(original.width, size.width), Math.max(original.height, size.height));
      return await this.takeScreenshot();
    } finally {
      await this.driver.manage().window().setRect(original);
    }
  }

  async saveScreenshot(path: string): Promise<void> {
    await writeFile(path, Buffer.from(await this.takeScreenshot(), "base64"));
  }

  async execute<T>(script: string | ((...args: never[]) => T), ...args: unknown[]): Promise<T> {
    return this.driver.executeScript(script as string, ...args) as Promise<T>;
  }

  async executeAsync<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.driver.executeAsyncScript(script, ...args) as Promise<T>;
  }

  $(selector: string): BrowserElement {
    return new BrowserElement(this.driver, selector);
  }

  private async findOptionalElement(selector: string): Promise<WebElement | undefined> {
    return (await this.driver.findElements(By.css(selector)))[0];
  }

  async elementState(selector: string): Promise<Record<string, unknown>> {
    return this.$(selector).state();
  }

  async elementCount(selector: string): Promise<number> {
    return (await this.driver.findElements(By.css(selector))).length;
  }

  async press(keys: string[], selector?: string): Promise<void> {
    const values = keys.map((key) => KeyboardKeys.resolve(key));
    if (selector) await (await this.driver.findElement(By.css(selector))).sendKeys(...values);
    else
      await this.driver
        .actions({ async: true })
        .sendKeys(...values)
        .perform();
  }

  async mouse(action: "hover" | "doubleClick" | "rightClick", selector: string): Promise<void> {
    const element = await this.driver.findElement(By.css(selector));
    const actions = this.driver.actions({ async: true });
    if (action === "hover") await actions.move({ origin: element }).perform();
    if (action === "doubleClick") await actions.doubleClick(element).perform();
    if (action === "rightClick") await actions.contextClick(element).perform();
  }

  async drag(source: string, target: string): Promise<void> {
    const from = await this.driver.findElement(By.css(source));
    const to = await this.driver.findElement(By.css(target));
    await this.driver.actions({ async: true }).dragAndDrop(from, to).perform();
  }

  async scroll(x: number, y: number): Promise<void> {
    await this.driver.executeScript("window.scrollBy(arguments[0], arguments[1])", x, y);
  }

  async back(): Promise<void> {
    await this.driver.navigate().back();
  }

  async forward(): Promise<void> {
    await this.driver.navigate().forward();
  }

  async refresh(): Promise<void> {
    await this.driver.navigate().refresh();
  }

  async alert(action: "get" | "accept" | "dismiss", text?: string): Promise<string> {
    const alert = await this.driver.switchTo().alert();
    const message = await alert.getText();
    if (text !== undefined) await alert.sendKeys(text);
    if (action === "accept") await alert.accept();
    if (action === "dismiss") await alert.dismiss();
    return message;
  }

  async windows(): Promise<{ current: string; handles: string[] }> {
    return { current: await this.driver.getWindowHandle(), handles: await this.driver.getAllWindowHandles() };
  }

  async switchWindow(handle: string): Promise<void> {
    await this.driver.switchTo().window(handle);
  }

  async closeWindow(): Promise<void> {
    await this.driver.close();
  }

  async newWindow(type: "tab" | "window"): Promise<void> {
    await this.driver.switchTo().newWindow(type);
  }

  async switchFrame(selector?: string): Promise<void> {
    if (!selector) await this.driver.switchTo().defaultContent();
    else await this.driver.switchTo().frame(await this.driver.findElement(By.css(selector)));
  }

  async cookies(): Promise<unknown[]> {
    return this.driver.manage().getCookies();
  }

  async setCookie(cookie: {
    name: string;
    value: string;
    path?: string;
    domain?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    expiry?: number;
  }): Promise<void> {
    await this.driver.manage().addCookie(cookie);
  }

  async deleteCookie(name?: string): Promise<void> {
    if (name) await this.driver.manage().deleteCookie(name);
    else await this.driver.manage().deleteAllCookies();
  }

  async storage(area: "local" | "session"): Promise<Record<string, string>> {
    return this.execute(`return Object.fromEntries(Object.entries(window.${area}Storage))`);
  }

  async setStorage(area: "local" | "session", key: string, value: string): Promise<void> {
    await this.execute(`window.${area}Storage.setItem(arguments[0], arguments[1])`, key, value);
  }

  async deleteStorage(area: "local" | "session", key?: string): Promise<void> {
    if (key) await this.execute(`window.${area}Storage.removeItem(arguments[0])`, key);
    else await this.execute(`window.${area}Storage.clear()`);
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

  async devtools(command: string, parameters: Record<string, unknown>): Promise<unknown> {
    const driver = this.driver as WebDriver & {
      sendAndGetDevToolsCommand?: (command: string, parameters: Record<string, unknown>) => Promise<unknown>;
    };
    if (!driver.sendAndGetDevToolsCommand) throw new Error("DevTools commands are not supported by this target.");
    return driver.sendAndGetDevToolsCommand(command, parameters);
  }

  async networkConditions(input: {
    offline: boolean;
    latencyMs: number;
    downloadBytesPerSecond: number;
    uploadBytesPerSecond: number;
  }): Promise<void> {
    await this.devtools("Network.emulateNetworkConditions", {
      offline: input.offline,
      latency: input.latencyMs,
      downloadThroughput: input.downloadBytesPerSecond,
      uploadThroughput: input.uploadBytesPerSecond,
    });
  }

  async geolocation(latitude: number, longitude: number, accuracy: number): Promise<void> {
    await this.devtools("Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
  }

  async permission(name: string, setting: "granted" | "denied" | "prompt", origin?: string): Promise<void> {
    await this.devtools("Browser.setPermission", {
      permission: { name },
      setting,
      ...(origin ? { origin } : {}),
    });
  }

  async blockUrls(patterns: string[]): Promise<void> {
    await this.devtools("Network.setBlockedURLs", { urls: patterns });
  }

  async clipboardWrite(text: string): Promise<void> {
    const result = await this.executeAsync<{ error?: string } | undefined>(
      "const done = arguments[arguments.length - 1]; navigator.clipboard.writeText(arguments[0]).then(() => done()).catch(error => done({error: error.message}))",
      text,
    );
    if (result?.error) throw new Error(result.error);
  }

  async clipboardRead(): Promise<string> {
    const result = await this.executeAsync<string | { error?: string }>(
      "const done = arguments[arguments.length - 1]; navigator.clipboard.readText().then(done).catch(error => done({error: error.message}))",
    );
    if (typeof result !== "string") throw new Error(result.error ?? "Could not read the clipboard.");
    return result;
  }

  async waitForElement(selector: string, timeoutMs: number): Promise<void> {
    await this.$(selector).waitForDisplayed({ timeout: timeoutMs });
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

  async waitForState(
    selector: string,
    state: "visible" | "hidden" | "present" | "absent" | "enabled" | "disabled" | "checked" | "unchecked",
    timeoutMs: number,
  ): Promise<void> {
    await this.driver.wait(async () => {
      const elements = await this.driver.findElements(By.css(selector));
      if (state === "absent") return elements.length === 0;
      if (state === "present") return elements.length > 0;
      const element = elements[0];
      if (!element) return state === "hidden";
      if (state === "visible" || state === "hidden") {
        const visible = await element.isDisplayed().catch(() => false);
        return state === "visible" ? visible : !visible;
      }
      if (state === "enabled" || state === "disabled") {
        const enabled = await element.isEnabled();
        return state === "enabled" ? enabled : !enabled;
      }
      const selected = await element.isSelected();
      return state === "checked" ? selected : !selected;
    }, timeoutMs);
  }

  async waitForValue(selector: string, value: string, timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => {
      const element = await this.findOptionalElement(selector);
      return element ? (await element.getAttribute("value")) === value : false;
    }, timeoutMs);
  }

  async waitForCount(selector: string, count: number, timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => (await this.driver.findElements(By.css(selector))).length === count, timeoutMs);
  }

  async waitForAttribute(selector: string, name: string, value: string | undefined, timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => {
      const element = await this.findOptionalElement(selector);
      if (!element) return false;
      const attribute = await element.getAttribute(name);
      return value === undefined ? attribute !== null : attribute === value;
    }, timeoutMs);
  }

  async waitForElementText(selector: string, text: string, timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => {
      const element = await this.findOptionalElement(selector);
      return element ? (await element.getText()).includes(text) : false;
    }, timeoutMs);
  }

  async waitForWindowCount(count: number, timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => (await this.driver.getAllWindowHandles()).length === count, timeoutMs);
  }

  async waitForNetworkIdle(quietMs: number, timeoutMs: number): Promise<void> {
    let lastCount = -1;
    let unchangedSince = Date.now();
    await this.driver.wait(async () => {
      const state = await this.execute<{ ready: boolean; resources: number }>(
        "return {ready: document.readyState === 'complete', resources: performance.getEntriesByType('resource').length}",
      );
      if (state.resources !== lastCount) {
        lastCount = state.resources;
        unchangedSince = Date.now();
      }
      return state.ready && Date.now() - unchangedSince >= quietMs;
    }, timeoutMs);
  }

  async waitForScript(script: string, arguments_: unknown[], timeoutMs: number): Promise<void> {
    await this.driver.wait(async () => Boolean(await this.execute(script, ...arguments_)), timeoutMs);
  }

  async getWindowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.driver.manage().window().getRect();
  }

  async setWindowRect(width: number, height: number): Promise<void> {
    await this.driver.manage().window().setRect({ width, height });
  }
}

export class KeyboardKeys {
  static resolve(value: string): string {
    const key = value.toUpperCase().replaceAll(" ", "_");
    const named = Key[key as keyof typeof Key];
    return typeof named === "string" ? named : value;
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
    const serverUrl = isMobile ? `http://${TestbenchDefaults.LOOPBACK_HOST}:${options.appiumPort}` : undefined;
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
    if (parsed.hostname === "localhost" || parsed.hostname === TestbenchDefaults.LOOPBACK_HOST) {
      parsed.hostname = TestbenchDefaults.ANDROID_EMULATOR_LOOPBACK_HOST;
    }
    return parsed.toString();
  }
}
