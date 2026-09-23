import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHandle } from "../../src/automation/browser-session.js";

describe("BrowserHandle DevTools discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the DevTools frontend for the currently open Chromium page", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            type: "page",
            url: "https://other.example/",
            devtoolsFrontendUrl: "https://devtools.example/other",
          },
          {
            type: "page",
            url: "https://application.example/",
            devtoolsFrontendUrl: "/devtools/inspector.html?ws=localhost:45678/devtools/page/application",
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const browser = Object.assign(Object.create(BrowserHandle.prototype) as object, {
      capabilities: { "goog:chromeOptions": { debuggerAddress: "localhost:45678" } },
      driver: { getCurrentUrl: vi.fn().mockResolvedValue("https://application.example/") },
    }) as unknown as BrowserHandle;

    await expect(browser.devToolsFrontendUrl()).resolves.toBe(
      "http://localhost:45678/devtools/inspector.html?ws=127.0.0.1:45678/devtools/page/application",
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:45678/json/list",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns no link when the browser does not expose a debugger address", async () => {
    const browser = Object.assign(Object.create(BrowserHandle.prototype) as object, {
      capabilities: {},
    }) as unknown as BrowserHandle;

    await expect(browser.devToolsFrontendUrl()).resolves.toBeUndefined();
  });
});
