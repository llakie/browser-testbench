import { Builder, By, Key, type WebDriver, type WebElement } from "selenium-webdriver";
import { writeFile } from "node:fs/promises";
import { TestbenchDefaults } from "../config/defaults.js";
import { TargetRegistry } from "../config/target-registry.js";
import type { TargetConfig } from "../config/types.js";
import { AndroidUsbNetwork } from "./android-usb-network.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { OperationWait } from "./operation-wait.js";

export class FreshElementAction {
  static async run<T>(
    driver: WebDriver,
    target: string,
    selector: string,
    action: string,
    execute: (element: WebElement) => Promise<T>,
  ): Promise<T> {
    let originalError: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let element: WebElement;
      try {
        element = await driver.findElement(By.css(selector));
      } catch (error) {
        if (!originalError) throw error;
        throw this.failure(target, selector, action, attempt, originalError, error);
      }
      try {
        return await execute(element);
      } catch (error) {
        if (attempt === 1 && this.isStale(error)) {
          originalError = error instanceof Error ? error : new Error(String(error));
          continue;
        }
        if (originalError && this.isStale(error))
          throw this.failure(target, selector, action, attempt, originalError, error);
        throw error;
      }
    }
    throw new Error("Element action retry ended unexpectedly.");
  }

  static isStale(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /stale element reference|element does not exist in cache|element is no longer attached/iu.test(
      `${error.name} ${error.message}`,
    );
  }

  private static failure(
    target: string,
    selector: string,
    action: string,
    attempt: number,
    originalError: Error,
    error: unknown,
  ): TestbenchError {
    return new TestbenchError("STALE_ELEMENT", `Element '${selector}' became stale during ${action}.`, {
      operation: `element.${action}`,
      status: 409,
      cause: error,
      details: {
        selector,
        action,
        target,
        attempt,
        originalDriverMessage: originalError.message,
      },
    });
  }
}

export class BrowserElement {
  constructor(
    private readonly driver: WebDriver,
    private readonly selector: string,
    private readonly target: string,
  ) {}

  private run<T>(action: string, execute: (element: WebElement) => Promise<T>): Promise<T> {
    return FreshElementAction.run(this.driver, this.target, this.selector, action, execute);
  }

  async click(): Promise<void> {
    await this.run("click", (element) => element.click());
  }

  async clearValue(): Promise<void> {
    await this.run("clear", (element) => element.clear());
  }

  async setValue(value: string): Promise<void> {
    await this.run("type", (element) => element.sendKeys(value));
  }

  async getText(): Promise<string> {
    return this.run("getText", (element) => element.getText());
  }

  async state(): Promise<Record<string, unknown>> {
    return this.run("state", async (element) => ({
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
    }));
  }

  async setChecked(checked: boolean): Promise<void> {
    await this.run(checked ? "check" : "uncheck", async (element) => {
      if ((await element.isSelected()) !== checked) await element.click();
    });
  }

  async select(values: string[], by: "value" | "text" | "index"): Promise<void> {
    await this.run(
      "select",
      (element) =>
        this.driver.executeScript(
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
          element,
          values,
          by,
        ) as Promise<unknown>,
    );
  }

  async upload(paths: string[]): Promise<void> {
    await this.run("upload", (element) => element.sendKeys(paths.join("\n")));
  }

  async focus(): Promise<void> {
    await this.run(
      "focus",
      (element) => this.driver.executeScript("arguments[0].focus()", element) as Promise<unknown>,
    );
  }

  async blur(): Promise<void> {
    await this.run("blur", (element) => this.driver.executeScript("arguments[0].blur()", element) as Promise<unknown>);
  }

  async scrollIntoView(): Promise<void> {
    await this.run(
      "scrollIntoView",
      (element) =>
        this.driver.executeScript(
          'arguments[0].scrollIntoView({block:"center",inline:"center"})',
          element,
        ) as Promise<unknown>,
    );
  }

  async submit(): Promise<void> {
    await this.run(
      "submit",
      (element) =>
        this.driver.executeScript(
          "const form = arguments[0].form ?? arguments[0].closest('form'); if (!form) throw new Error('Element is not associated with a form.'); form.requestSubmit ? form.requestSubmit() : form.submit();",
          element,
        ) as Promise<unknown>,
    );
  }

  async screenshot(): Promise<string> {
    return this.run("screenshot", (element) => element.takeScreenshot());
  }

  async waitForDisplayed(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<void> {
    const timeout = options.timeout ?? TestbenchDefaults.WAIT_TIMEOUT_MS;
    await OperationWait.until(
      async () => {
        const [element] = await this.driver.findElements(By.css(this.selector));
        return element ? element.isDisplayed().catch(() => false) : false;
      },
      {
        operation: "wait.element",
        timeoutMs: timeout,
        signal: options.signal,
        details: { selector: this.selector },
      },
    );
  }

  async waitForClickable(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<void> {
    const timeout = options.timeout ?? TestbenchDefaults.WAIT_TIMEOUT_MS;
    await OperationWait.until(
      async () => {
        const element = await this.driver.findElement(By.css(this.selector)).catch(() => undefined);
        return Boolean(element && (await element.isDisplayed()) && (await element.isEnabled()));
      },
      {
        operation: "wait.clickable",
        timeoutMs: timeout,
        signal: options.signal,
        details: { selector: this.selector },
      },
    );
  }
}

export class BrowserHandle {
  private constructor(
    private readonly driver: WebDriver,
    readonly sessionId: string,
    readonly capabilities: Record<string, unknown>,
    private readonly target: string,
  ) {}

  static async create(
    capabilities: Record<string, unknown>,
    serverUrl?: string,
    target = "unknown",
  ): Promise<BrowserHandle> {
    let builder = new Builder().withCapabilities(capabilities);
    if (serverUrl) builder = builder.usingServer(serverUrl);
    const driver = await builder.build();
    const session = await driver.getSession();
    const returnedCapabilities = await driver.getCapabilities();
    const runtime = Object.fromEntries(
      [...returnedCapabilities.keys()].map((key) => [key, returnedCapabilities.get(key)]),
    );
    return new BrowserHandle(driver, session.getId(), runtime, target);
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
    return new BrowserElement(this.driver, selector, this.target);
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
    if (selector)
      await FreshElementAction.run(this.driver, this.target, selector, "press", (element) =>
        element.sendKeys(...values),
      );
    else
      await this.driver
        .actions({ async: true })
        .sendKeys(...values)
        .perform();
  }

  async mouse(action: "hover" | "doubleClick" | "rightClick", selector: string): Promise<void> {
    await FreshElementAction.run(this.driver, this.target, selector, action, async (element) => {
      const actions = this.driver.actions({ async: true });
      if (action === "hover") await actions.move({ origin: element }).perform();
      if (action === "doubleClick") await actions.doubleClick(element).perform();
      if (action === "rightClick") await actions.contextClick(element).perform();
    });
  }

  async drag(source: string, target: string): Promise<void> {
    await FreshElementAction.run(this.driver, this.target, source, "drag", (from) =>
      FreshElementAction.run(this.driver, this.target, target, "drag", (to) =>
        this.driver.actions({ async: true }).dragAndDrop(from, to).perform(),
      ),
    );
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

  async devToolsFrontendUrl(): Promise<string | undefined> {
    const options = [this.capabilities["goog:chromeOptions"], this.capabilities["ms:edgeOptions"]].find(
      (value): value is Record<string, unknown> => Boolean(value && typeof value === "object"),
    );
    const debuggerAddress = options?.debuggerAddress;
    if (typeof debuggerAddress !== "string" || !debuggerAddress) return undefined;

    try {
      const response = await fetch(`http://${debuggerAddress}/json/list`, {
        signal: AbortSignal.timeout(TestbenchDefaults.DEVTOOLS_DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const targets = (await response.json()) as Array<{
        type?: string;
        url?: string;
        devtoolsFrontendUrl?: string;
      }>;
      const currentUrl = await this.getUrl().catch(() => undefined);
      const page =
        targets.find((target) => target.type === "page" && target.url === currentUrl) ??
        targets.find((target) => target.type === "page");
      const frontendUrl = page?.devtoolsFrontendUrl;
      if (typeof frontendUrl !== "string") return undefined;
      const resolvedUrl = frontendUrl.startsWith("/")
        ? new URL(frontendUrl, `http://${debuggerAddress}`).toString()
        : frontendUrl;
      return resolvedUrl.replace("ws=localhost:", `ws=${TestbenchDefaults.LOOPBACK_HOST}:`);
    } catch {
      return undefined;
    }
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

  async waitForElement(selector: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.$(selector).waitForDisplayed({ timeout: timeoutMs, signal });
  }

  async waitForText(text: string, timeoutMs = TestbenchDefaults.WAIT_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(
      async () => this.execute<boolean>("return (document.body?.innerText ?? '').includes(arguments[0])", text),
      { operation: "wait.text", timeoutMs, signal, details: { text } },
    );
  }

  async waitForUrl(value: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(async () => (await this.getUrl()).includes(value), {
      operation: "wait.url",
      timeoutMs,
      signal,
      details: { value },
    });
  }

  async waitForState(
    selector: string,
    state: "visible" | "hidden" | "present" | "absent" | "enabled" | "disabled" | "checked" | "unchecked",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await OperationWait.until(
      async () => {
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
      },
      { operation: "wait.state", timeoutMs, signal, details: { selector, state } },
    );
  }

  async waitForValue(selector: string, value: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(
      async () => {
        const element = await this.findOptionalElement(selector);
        return element ? (await element.getAttribute("value")) === value : false;
      },
      { operation: "wait.value", timeoutMs, signal, details: { selector, value } },
    );
  }

  async waitForCount(selector: string, count: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(async () => (await this.driver.findElements(By.css(selector))).length === count, {
      operation: "wait.count",
      timeoutMs,
      signal,
      details: { selector, count },
    });
  }

  async waitForAttribute(
    selector: string,
    name: string,
    value: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await OperationWait.until(
      async () => {
        const element = await this.findOptionalElement(selector);
        if (!element) return false;
        const attribute = await element.getAttribute(name);
        return value === undefined ? attribute !== null : attribute === value;
      },
      { operation: "wait.attribute", timeoutMs, signal, details: { selector, name, value } },
    );
  }

  async waitForElementText(selector: string, text: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(
      async () => {
        const element = await this.findOptionalElement(selector);
        return element ? (await element.getText()).includes(text) : false;
      },
      { operation: "wait.elementText", timeoutMs, signal, details: { selector, text } },
    );
  }

  async waitForWindowCount(count: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(async () => (await this.driver.getAllWindowHandles()).length === count, {
      operation: "wait.windowCount",
      timeoutMs,
      signal,
      details: { count },
    });
  }

  async waitForNetworkIdle(quietMs: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    let lastCount = -1;
    let unchangedSince = Date.now();
    await OperationWait.until(
      async () => {
        const state = await this.execute<{ ready: boolean; resources: number }>(
          "return {ready: document.readyState === 'complete', resources: performance.getEntriesByType('resource').length}",
        );
        if (state.resources !== lastCount) {
          lastCount = state.resources;
          unchangedSince = Date.now();
        }
        return state.ready && Date.now() - unchangedSince >= quietMs;
      },
      { operation: "wait.networkIdle", timeoutMs, signal, details: { quietMs } },
    );
  }

  async waitForScript(script: string, arguments_: unknown[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await OperationWait.until(async () => Boolean(await this.execute(script, ...arguments_)), {
      operation: "wait.script",
      timeoutMs,
      signal,
      details: { condition: script },
    });
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
  private androidUsbNetwork?: AndroidUsbNetwork;
  private target?: TargetConfig;

  get active(): BrowserHandle {
    if (!this.browser) throw new Error("No browser session is active.");
    return this.browser;
  }

  async start(
    target: TargetConfig,
    options: { appiumPort?: number; logLevel?: "silent" | "error" | "warn" | "info"; targetId?: string } = {},
  ): Promise<BrowserHandle> {
    if (this.browser) await this.close();
    const isMobile = TargetRegistry.definitions[target.name].kind === "mobile";
    const serverUrl = isMobile ? `http://${TestbenchDefaults.LOOPBACK_HOST}:${options.appiumPort}` : undefined;
    this.target = target;
    this.androidUsbNetwork = new AndroidUsbNetwork(target);
    try {
      this.browser = await BrowserHandle.create(
        TargetRegistry.capabilities(target),
        serverUrl,
        options.targetId ?? target.name,
      );
      return this.browser;
    } catch (error) {
      this.target = undefined;
      this.androidUsbNetwork = undefined;
      throw error;
    }
  }

  async navigate(url: string): Promise<void> {
    const mapped = this.target ? BrowserSession.urlForTarget(url, this.target) : url;
    const prepared = await this.androidUsbNetwork?.prepare(mapped);
    await this.active.url(prepared ?? mapped);
  }

  async close(): Promise<void> {
    const current = this.browser;
    this.browser = undefined;
    try {
      if (current) await current.deleteSession();
    } finally {
      try {
        await this.androidUsbNetwork?.close();
      } finally {
        this.androidUsbNetwork = undefined;
        this.target = undefined;
      }
    }
  }

  static urlForTarget(url: string, target: TargetConfig): string {
    if (target.name !== "chrome-android" || target.deviceKind === "physical") return url;
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === TestbenchDefaults.LOOPBACK_HOST) {
      parsed.hostname = TestbenchDefaults.ANDROID_EMULATOR_LOOPBACK_HOST;
    }
    return parsed.toString();
  }
}
