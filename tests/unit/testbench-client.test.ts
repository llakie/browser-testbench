import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestTargetInfo } from "../../src/config/types.js";
import {
  BrowserOrientation,
  PinchDirection,
  RemoteTestbench,
  SwipeDirection,
  TestbenchError,
} from "../../src/transports/testbench-client.js";
import { ClientVersion } from "../../src/config/client-version.js";

describe("RemoteTestbench.availableTargets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("exports type-safe interaction values for project tests", () => {
    expect(BrowserOrientation.Landscape).toBe("LANDSCAPE");
    expect(SwipeDirection.Up).toBe("up");
    expect(PinchDirection.Out).toBe("out");
  });

  it("returns ready requested IDs in the requested order", async () => {
    const testbench = new RemoteTestbench();
    vi.spyOn(testbench, "targets").mockResolvedValue([
      target("chrome", true),
      target("firefox", false),
      target("safari-ios-iphone-17-pro-26-5", true),
    ]);

    await expect(testbench.availableTargets(["firefox", "safari-ios-iphone-17-pro-26-5", "chrome"])).resolves.toEqual([
      "safari-ios-iphone-17-pro-26-5",
      "chrome",
    ]);
  });

  it("rejects when no requested target is ready", async () => {
    const testbench = new RemoteTestbench();
    vi.spyOn(testbench, "targets").mockResolvedValue([target("chrome", false)]);

    await expect(testbench.availableTargets(["chrome", "missing"])).rejects.toThrow(
      "None of the requested Browser Testbench targets are ready",
    );
  });

  it("allows cold mobile targets enough time to start", async () => {
    const testbench = new RemoteTestbench();
    const request = vi.spyOn(testbench, "request").mockResolvedValue({
      id: "session",
      target: "chrome-android-pixel-8-16",
      createdAt: new Date().toISOString(),
      runtime: {},
    });

    await testbench.open({ target: "chrome-android-pixel-8-16" });
    await testbench.verify("safari-ios-iphone-17-pro-26-5");

    expect(request).toHaveBeenNthCalledWith(1, "/v1/sessions", expect.objectContaining({ timeoutMs: 7 * 60_000 }));
    expect(request).toHaveBeenNthCalledWith(2, "/v1/verify", expect.objectContaining({ timeoutMs: 7 * 60_000 }));
  });

  it("keeps the transport alive for caller-defined waits and downloads", async () => {
    const testbench = new RemoteTestbench();
    const request = vi.spyOn(testbench, "request").mockResolvedValue({
      id: "session",
      target: "chrome",
      createdAt: new Date().toISOString(),
      runtime: {},
    });
    const session = await testbench.open({ target: "chrome" });
    request.mockClear();

    await session.waitForText("ready", 180_000);
    await session.waitForDownload("report.pdf", 240_000);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/v1/sessions/session/wait",
      expect.objectContaining({ timeoutMs: 185_000 }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/v1/sessions/session/browser",
      expect.objectContaining({ timeoutMs: 245_000 }),
    );
  });

  it("supports wait options without breaking positional timeouts", async () => {
    const testbench = new RemoteTestbench();
    const request = vi.spyOn(testbench, "request").mockResolvedValue({
      id: "session",
      target: "chrome",
      createdAt: new Date().toISOString(),
      runtime: {},
    });
    const session = await testbench.open({ target: "chrome" });
    request.mockClear();
    const controller = new AbortController();

    await session.waitForElement("#result", { timeoutMs: 90_000, signal: controller.signal });

    expect(request).toHaveBeenCalledWith(
      "/v1/sessions/session/wait",
      expect.objectContaining({ timeoutMs: 95_000, signal: controller.signal }),
    );
  });

  it("rejects invalid wait timeouts before sending a request", async () => {
    const testbench = new RemoteTestbench();
    vi.spyOn(testbench, "request").mockResolvedValue({
      id: "session",
      target: "chrome",
      createdAt: new Date().toISOString(),
      runtime: {},
    });
    const session = await testbench.open({ target: "chrome" });

    await expect(session.waitForElement("#result", { timeoutMs: Infinity })).rejects.toThrow("positive finite number");
  });

  it("lists and closes recoverable sessions", async () => {
    const testbench = new RemoteTestbench();
    const request = vi
      .spyOn(testbench, "request")
      .mockResolvedValueOnce([{ id: "session", target: "chrome", createdAt: new Date().toISOString(), runtime: {} }])
      .mockResolvedValueOnce({ closed: true });

    const [session] = await testbench.sessions();
    await testbench.closeSession(session!.id);

    expect(session).toMatchObject({ id: "session", target: "chrome" });
    expect(request).toHaveBeenNthCalledWith(1, "/v1/sessions");
    expect(request).toHaveBeenNthCalledWith(2, "/v1/sessions/session", { method: "DELETE" });
  });

  it("aborts requests after the configured client timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            }),
          ),
      ),
    );
    const testbench = new RemoteTestbench({ requestTimeoutMs: 20 });

    await expect(testbench.targets()).rejects.toThrow("timed out after 20 ms");
  });

  it("distinguishes caller aborts from transport timeouts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            }),
          ),
      ),
    );
    const controller = new AbortController();
    const request = new RemoteTestbench({ requestTimeoutMs: 10_000 }).request("/v1/sessions/id/wait", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "OPERATION_ABORTED", operation: "wait" });
  });

  it("identifies every request with the exact package version", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new RemoteTestbench().targets();

    const init = fetchMock.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get(ClientVersion.HEADER)).toBe(ClientVersion.CURRENT);
  });

  it("preserves structured server errors for callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "TARGET_BUSY",
              message: "Target is busy.",
              operation: "session.open",
              details: { target: "chrome" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const error = await new RemoteTestbench().targets().catch((caught) => caught);

    expect(error).toBeInstanceOf(TestbenchError);
    expect(error).toMatchObject({
      code: "TARGET_BUSY",
      operation: "session.open",
      status: 409,
      details: { target: "chrome" },
    });
  });
});

function target(id: string, ready: boolean): TestTargetInfo {
  return {
    id,
    browser: "chrome",
    label: id,
    kind: "desktop",
    status: ready ? "ready" : "blocked",
    ready,
    serial: false,
    detail: id,
  };
}
