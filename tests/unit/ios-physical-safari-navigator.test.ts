import { afterEach, describe, expect, it, vi } from "vitest";
import { IosPhysicalSafariNavigator } from "../../src/automation/ios-physical-safari-navigator.js";

describe("IosPhysicalSafariNavigator", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses initial deeplinks only on supported physical iOS versions", () => {
    expect(
      IosPhysicalSafariNavigator.supportsInitialDeeplink({
        name: "safari-ios",
        deviceKind: "physical",
        platformVersion: "16.4",
      }),
    ).toBe(true);
    expect(
      IosPhysicalSafariNavigator.supportsInitialDeeplink({
        name: "safari-ios",
        deviceKind: "physical",
        platformVersion: "16.3.1",
      }),
    ).toBe(false);
    expect(
      IosPhysicalSafariNavigator.supportsInitialDeeplink({
        name: "safari-ios",
        deviceKind: "simulator",
        platformVersion: "26.5",
      }),
    ).toBe(false);
  });

  it("uses Appium's native deeplink command and restores the current web context", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        requests.push({ url, method, body });
        let value: unknown = null;
        if (url.endsWith("/context") && method === "GET") value = "WEBVIEW_current";
        if (url.endsWith("/contexts")) value = ["WEBVIEW_current"];
        if (url.endsWith("/element") && body?.value === "TabBarItemTitle") {
          value = { "element-6066-11e4-a52e-4f735466cecf": "address" };
        }
        if (url.endsWith("/element/address/attribute/value")) value = "\u200eexample.com, Secure";
        return new Response(JSON.stringify({ value }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await IosPhysicalSafariNavigator.navigate(4723, "session-id", "https://example.com/path", {
      name: "safari-ios",
      deviceKind: "physical",
      platformVersion: "16.7.11",
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringContaining("/execute/sync"),
          body: {
            script: "mobile: deepLink",
            args: [{ url: "https://example.com/path", bundleId: "com.apple.mobilesafari" }],
          },
        }),
      ]),
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining("/element/address/attribute/value") }),
        expect.objectContaining({ url: expect.stringContaining("/context"), body: { name: "WEBVIEW_current" } }),
      ]),
    );
  });

  it("falls back to Safari's native address field and restores the current web context", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        requests.push({ url, method, body });
        let value: unknown = null;
        if (url.endsWith("/context") && method === "GET") value = "WEBVIEW_previous";
        if (url.endsWith("/contexts")) value = ["NATIVE_APP", "WEBVIEW_current"];
        if (url.endsWith("/execute/sync")) {
          return new Response(JSON.stringify({ value: { error: "unknown error", message: "deeplink failed" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/element") && body?.value === "TabBarItemTitle") {
          value = { "element-6066-11e4-a52e-4f735466cecf": "address" };
        }
        if (url.endsWith("/element") && body?.value === "URL") {
          value = { "element-6066-11e4-a52e-4f735466cecf": "input" };
        }
        if (url.endsWith("/element/address/attribute/value")) value = "example.com, Secure";
        return new Response(JSON.stringify({ value }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await IosPhysicalSafariNavigator.navigate(4723, "session-id", "https://example.com/path", {
      name: "safari-ios",
      deviceKind: "physical",
      platformVersion: "16.7.11",
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining("/context"), body: { name: "NATIVE_APP" } }),
        expect.objectContaining({
          url: expect.stringContaining("/element/input/value"),
          body: expect.objectContaining({ text: "https://example.com/path" }),
        }),
        expect.objectContaining({ url: expect.stringContaining("/actions") }),
        expect.objectContaining({ url: expect.stringContaining("/context"), body: { name: "WEBVIEW_current" } }),
      ]),
    );
  });
});
