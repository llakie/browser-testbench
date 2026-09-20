import { TestbenchDefaults } from "../config/defaults.js";
import type { TargetConfig } from "../config/types.js";
import { NetworkUrl } from "../infrastructure/network-url.js";
import { AppiumCommandError, AppiumSessionClient } from "./appium-session-client.js";

const WEB_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const SAFARI_ADDRESS_ELEMENT_IDS = ["TabBarItemTitle", "URL"];
const REQUEST_SLICE_MS = 1_000;

class NavigationConfirmationError extends Error {}

export class IosPhysicalSafariNavigator {
  static supportsInitialDeeplink(target: TargetConfig): boolean {
    if (target.name !== "safari-ios" || target.deviceKind !== "physical" || !target.platformVersion) return false;
    const [major = 0, minor = 0] = target.platformVersion.split(".").map(Number);
    return major > 16 || (major === 16 && minor >= 4);
  }

  static async navigate(port: number, sessionId: string, url: string, target: TargetConfig): Promise<void> {
    const client = new AppiumSessionClient(port, sessionId);
    const deadline = this.deadline();
    if (this.supportsInitialDeeplink(target) && (await this.navigateThroughDeeplink(client, url, deadline))) return;
    await this.navigateThroughAddressField(client, url, deadline);
  }

  private static async navigateThroughDeeplink(
    client: AppiumSessionClient,
    url: string,
    deadline: number,
  ): Promise<boolean> {
    const originalContext = await client.request<string>("context", "GET", undefined, this.remaining(deadline));
    const originalUrl = originalContext.startsWith("WEBVIEW")
      ? await this.optionalWebUrl(client, this.requestTimeout(deadline))
      : undefined;
    try {
      await client.request(
        "execute/sync",
        "POST",
        { script: "mobile: deepLink", args: [{ url, bundleId: "com.apple.mobilesafari" }] },
        this.remaining(deadline),
      );
    } catch (error) {
      if (this.isUnsupportedDeeplink(error)) return false;
      throw error;
    }

    await client.request("context", "POST", { name: "NATIVE_APP" }, this.remaining(deadline));
    try {
      await this.waitForAddress(client, url, deadline);
    } catch (error) {
      await this.restoreWebContext(client, originalContext, this.cleanupDeadline(deadline)).catch(() => undefined);
      if (error instanceof NavigationConfirmationError) return false;
      throw error;
    }
    const currentUrl = await this.restoreWebContext(client, originalContext, deadline, url, originalUrl);
    await this.waitForChangedWebUrl(client, originalUrl, url, deadline, currentUrl);
    return true;
  }

  private static async navigateThroughAddressField(
    client: AppiumSessionClient,
    url: string,
    deadline: number,
  ): Promise<void> {
    const originalContext = await client.request<string>("context", "GET", undefined, this.remaining(deadline));
    const originalUrl = originalContext.startsWith("WEBVIEW")
      ? await this.optionalWebUrl(client, this.requestTimeout(deadline))
      : undefined;
    await client.request("context", "POST", { name: "NATIVE_APP" }, this.remaining(deadline));

    let currentUrl: string | undefined;
    try {
      const address = await this.findFirstElement(client, SAFARI_ADDRESS_ELEMENT_IDS, deadline);
      await client.request(`element/${address}/click`, "POST", {}, this.remaining(deadline));
      const input = await this.waitForElement(client, "URL", deadline);
      await client.request(`element/${input}/clear`, "POST", {}, this.remaining(deadline));
      await client.request(`element/${input}/value`, "POST", { text: url, value: [...url] }, this.remaining(deadline));
      await client.request(
        "actions",
        "POST",
        {
          actions: [
            {
              type: "key",
              id: "keyboard",
              actions: [
                { type: "keyDown", value: "\uE007" },
                { type: "keyUp", value: "\uE007" },
              ],
            },
          ],
        },
        this.remaining(deadline),
      );
      await this.waitForAddress(client, url, deadline);
    } finally {
      currentUrl = await this.restoreWebContext(
        client,
        originalContext,
        this.cleanupDeadline(deadline),
        url,
        originalUrl,
      );
    }
    await this.waitForChangedWebUrl(client, originalUrl, url, deadline, currentUrl);
  }

  private static async findFirstElement(
    client: AppiumSessionClient,
    accessibilityIds: string[],
    deadline: number,
  ): Promise<string> {
    let lastError: unknown;
    for (const accessibilityId of accessibilityIds) {
      try {
        return await this.findElement(client, accessibilityId, deadline);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Safari's address field is not available on the connected iOS device.", { cause: lastError });
  }

  private static async waitForElement(
    client: AppiumSessionClient,
    accessibilityId: string,
    deadline: number,
  ): Promise<string> {
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.findElement(client, accessibilityId, deadline);
      } catch (error) {
        lastError = error;
      }
      await this.pause(deadline);
    }
    throw new Error(`Safari's ${accessibilityId} element did not become available.`, { cause: lastError });
  }

  private static async findElement(
    client: AppiumSessionClient,
    accessibilityId: string,
    deadline: number,
  ): Promise<string> {
    const result = await client.request<Record<string, string>>(
      "element",
      "POST",
      { using: "accessibility id", value: accessibilityId },
      this.requestTimeout(deadline),
    );
    const element = result[WEB_ELEMENT_KEY] ?? result.ELEMENT;
    if (!element) throw new Error(`Appium did not return an element for '${accessibilityId}'.`);
    return element;
  }

  private static async waitForAddress(client: AppiumSessionClient, url: string, deadline: number): Promise<void> {
    const expectedHost = NetworkUrl.comparableHostname(new URL(url).hostname);
    let lastValue = "";
    while (Date.now() < deadline) {
      try {
        const address = await this.findFirstElement(client, SAFARI_ADDRESS_ELEMENT_IDS, deadline);
        lastValue = await client.request<string>(
          `element/${address}/attribute/value`,
          "GET",
          undefined,
          this.requestTimeout(deadline),
        );
        if (this.addressHasHost(lastValue, expectedHost)) return;
      } catch (error) {
        if (this.isTerminalSessionError(error)) throw error;
      }
      await this.pause(deadline);
    }
    throw new NavigationConfirmationError(
      `Safari did not open '${expectedHost}'. Current address: '${lastValue || "unknown"}'.`,
    );
  }

  private static async restoreWebContext(
    client: AppiumSessionClient,
    originalContext: string,
    deadline: number,
    requestedUrl?: string,
    originalUrl?: string,
  ): Promise<string | undefined> {
    if (originalContext === "NATIVE_APP") return undefined;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const contexts = await client.request<string[]>("contexts", "GET", undefined, this.requestTimeout(deadline));
        const webContexts = contexts.filter((context) => context.startsWith("WEBVIEW"));
        for (const webContext of webContexts.toReversed()) {
          await client.request("context", "POST", { name: webContext }, this.requestTimeout(deadline));
          if (!requestedUrl) return undefined;
          const currentUrl = await this.optionalWebUrl(client, this.requestTimeout(deadline));
          if (currentUrl && this.isRequestedNavigation(currentUrl, originalUrl, requestedUrl)) return currentUrl;
        }
        const fallbackContext = webContexts.at(-1);
        if (fallbackContext) {
          await client.request("context", "POST", { name: fallbackContext }, this.requestTimeout(deadline));
          return undefined;
        }
      } catch (error) {
        lastError = error;
        if (this.isTerminalSessionError(error)) throw error;
      }
      await this.pause(deadline);
    }
    throw new Error("Safari loaded the URL, but Appium could not restore its web context.", { cause: lastError });
  }

  private static async waitForChangedWebUrl(
    client: AppiumSessionClient,
    originalUrl: string | undefined,
    requestedUrl: string,
    deadline: number,
    observedUrl?: string,
  ): Promise<void> {
    if (!originalUrl || !this.sameHost(originalUrl, requestedUrl) || this.sameUrl(originalUrl, requestedUrl)) return;
    let lastUrl = observedUrl ?? originalUrl;
    if (this.isRequestedNavigation(lastUrl, originalUrl, requestedUrl)) return;
    while (Date.now() < deadline) {
      try {
        lastUrl = await client.request<string>("url", "GET", undefined, this.requestTimeout(deadline));
        if (!this.sameUrl(lastUrl, originalUrl) && this.sameHost(lastUrl, requestedUrl)) return;
      } catch (error) {
        if (this.isTerminalSessionError(error)) throw error;
      }
      await this.pause(deadline);
    }
    throw new NavigationConfirmationError(
      `Safari stayed on '${originalUrl}' instead of navigating to '${requestedUrl}'. Last URL: '${lastUrl}'.`,
    );
  }

  private static isRequestedNavigation(
    currentUrl: string,
    originalUrl: string | undefined,
    requestedUrl: string,
  ): boolean {
    if (!this.sameHost(currentUrl, requestedUrl)) return false;
    return !originalUrl || this.sameUrl(originalUrl, requestedUrl) || !this.sameUrl(currentUrl, originalUrl);
  }

  private static async optionalWebUrl(
    client: AppiumSessionClient,
    timeoutMs = REQUEST_SLICE_MS,
  ): Promise<string | undefined> {
    try {
      return await client.request<string>("url", "GET", undefined, timeoutMs);
    } catch {
      return undefined;
    }
  }

  private static addressHasHost(value: string, expectedHost: string): boolean {
    const normalized = value.replace(/[\u200e\u200f\u202a-\u202e]/gu, "").toLowerCase();
    const host = expectedHost.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|://)(?:www\\.)?${host}(?=$|[/:,\\s])`, "u").test(normalized);
  }

  private static sameHost(left: string, right: string): boolean {
    return (
      NetworkUrl.comparableHostname(new URL(left).hostname) === NetworkUrl.comparableHostname(new URL(right).hostname)
    );
  }

  private static sameUrl(left: string, right: string): boolean {
    const normalize = (value: string) => {
      const url = new URL(value);
      url.hostname = NetworkUrl.comparableHostname(url.hostname);
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    };
    return normalize(left) === normalize(right);
  }

  private static isUnsupportedDeeplink(error: unknown): boolean {
    return (
      error instanceof AppiumCommandError &&
      /unknown command|unsupported|not implemented|not supported|unknown mobile command/iu.test(
        `${error.code ?? ""} ${error.message}`,
      )
    );
  }

  private static isTerminalSessionError(error: unknown): boolean {
    return (
      error instanceof AppiumCommandError &&
      /invalid session|no such driver|session.*(?:deleted|terminated)/iu.test(error.message)
    );
  }

  private static deadline(): number {
    return Date.now() + TestbenchDefaults.IOS_NATIVE_NAVIGATION_TIMEOUT_MS;
  }

  private static remaining(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new NavigationConfirmationError("Safari navigation timed out.");
    return remaining;
  }

  private static requestTimeout(deadline: number): number {
    return Math.min(REQUEST_SLICE_MS, this.remaining(deadline));
  }

  private static cleanupDeadline(deadline: number): number {
    return Math.max(deadline, Date.now() + REQUEST_SLICE_MS);
  }

  private static async pause(deadline: number): Promise<void> {
    const delay = Math.min(TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
