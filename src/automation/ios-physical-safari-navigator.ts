import { TestbenchDefaults } from "../config/defaults.js";
import type { TargetConfig } from "../config/types.js";

const WEB_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const SAFARI_ADDRESS_ELEMENT_IDS = ["TabBarItemTitle", "URL"];

interface AppiumResponse<T> {
  value: T | { error?: string; message?: string };
}

export class IosPhysicalSafariNavigator {
  static supportsInitialDeeplink(target: TargetConfig): boolean {
    if (target.name !== "safari-ios" || target.deviceKind !== "physical" || !target.platformVersion) return false;
    const [major = 0, minor = 0] = target.platformVersion.split(".").map(Number);
    return major > 16 || (major === 16 && minor >= 4);
  }

  static async navigate(port: number, sessionId: string, url: string, target: TargetConfig): Promise<void> {
    const baseUrl = `http://${TestbenchDefaults.LOOPBACK_HOST}:${port}/session/${sessionId}`;
    if (this.supportsInitialDeeplink(target)) {
      let originalContext: string | undefined;
      try {
        originalContext = await this.request<string>(`${baseUrl}/context`);
        await this.request(`${baseUrl}/execute/sync`, "POST", {
          script: "mobile: deepLink",
          args: [{ url, bundleId: "com.apple.mobilesafari" }],
        });
        await this.request(`${baseUrl}/context`, "POST", { name: "NATIVE_APP" });
        await this.waitForAddress(baseUrl, url);
        await this.restoreWebContext(baseUrl, originalContext);
        return;
      } catch {
        if (originalContext) await this.restoreWebContext(baseUrl, originalContext).catch(() => undefined);
        // Older device services may reject the command even when the OS version supports it.
      }
    }
    await this.navigateThroughAddressField(baseUrl, url);
  }

  private static async navigateThroughAddressField(baseUrl: string, url: string): Promise<void> {
    const originalContext = await this.request<string>(`${baseUrl}/context`);
    await this.request(`${baseUrl}/context`, "POST", { name: "NATIVE_APP" });

    try {
      const address = await this.findFirstElement(baseUrl, SAFARI_ADDRESS_ELEMENT_IDS);
      await this.request(`${baseUrl}/element/${address}/click`, "POST", {});
      const input = await this.waitForElement(baseUrl, "URL");
      await this.request(`${baseUrl}/element/${input}/clear`, "POST", {});
      await this.request(`${baseUrl}/element/${input}/value`, "POST", {
        text: url,
        value: [...url],
      });
      await this.request(`${baseUrl}/actions`, "POST", {
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
      });
      await this.waitForAddress(baseUrl, url);
    } finally {
      await this.restoreWebContext(baseUrl, originalContext);
    }
  }

  private static async findFirstElement(baseUrl: string, accessibilityIds: string[]): Promise<string> {
    let lastError: unknown;
    for (const accessibilityId of accessibilityIds) {
      try {
        return await this.findElement(baseUrl, accessibilityId);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Safari's address field is not available on the connected iOS device.", { cause: lastError });
  }

  private static async waitForElement(baseUrl: string, accessibilityId: string): Promise<string> {
    const deadline = Date.now() + TestbenchDefaults.IOS_NATIVE_NAVIGATION_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.findElement(baseUrl, accessibilityId);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS));
    }
    throw new Error(`Safari's ${accessibilityId} element did not become available.`, { cause: lastError });
  }

  private static async findElement(baseUrl: string, accessibilityId: string): Promise<string> {
    const result = await this.request<Record<string, string>>(`${baseUrl}/element`, "POST", {
      using: "accessibility id",
      value: accessibilityId,
    });
    const element = result[WEB_ELEMENT_KEY] ?? result.ELEMENT;
    if (!element) throw new Error(`Appium did not return an element for '${accessibilityId}'.`);
    return element;
  }

  private static async waitForAddress(baseUrl: string, url: string): Promise<void> {
    const expectedHost = new URL(url).hostname.replace(/^www\./iu, "").toLowerCase();
    const deadline = Date.now() + TestbenchDefaults.IOS_NATIVE_NAVIGATION_TIMEOUT_MS;
    let lastValue = "";
    while (Date.now() < deadline) {
      try {
        const address = await this.findFirstElement(baseUrl, SAFARI_ADDRESS_ELEMENT_IDS);
        lastValue = await this.request<string>(`${baseUrl}/element/${address}/attribute/value`);
        const currentAddress = lastValue.replace(/[\u200e\u200f\u202a-\u202e]/gu, "").toLowerCase();
        if (currentAddress.includes(expectedHost)) return;
      } catch {
        // Safari is still replacing the current page.
      }
      await new Promise((resolve) => setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS));
    }
    throw new Error(`Safari did not open '${expectedHost}'. Current address: '${lastValue || "unknown"}'.`);
  }

  private static async restoreWebContext(baseUrl: string, originalContext: string): Promise<void> {
    if (originalContext === "NATIVE_APP") return;
    const deadline = Date.now() + TestbenchDefaults.IOS_NATIVE_NAVIGATION_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const contexts = await this.request<string[]>(`${baseUrl}/contexts`);
        const webContexts = contexts.filter((context) => context.startsWith("WEBVIEW"));
        const webContext = webContexts.at(-1) ?? (contexts.includes(originalContext) ? originalContext : undefined);
        if (webContext) {
          await this.request(`${baseUrl}/context`, "POST", { name: webContext });
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, TestbenchDefaults.DOWNLOAD_POLL_INTERVAL_MS));
    }
    throw new Error("Safari loaded the URL, but Appium could not restore its web context.", { cause: lastError });
  }

  private static async request<T = null>(
    url: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TestbenchDefaults.IOS_NATIVE_NAVIGATION_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({ value: null }))) as AppiumResponse<T>;
    const error = payload.value as { error?: string; message?: string } | null;
    const hasError = typeof error?.error === "string";
    if (!response.ok || hasError) {
      const detail = hasError ? error.message : undefined;
      throw new Error(detail ?? `Appium returned HTTP ${response.status} for ${method} ${url}.`);
    }
    return payload.value as T;
  }
}
