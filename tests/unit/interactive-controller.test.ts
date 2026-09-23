import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveController } from "../../src/automation/interactive-controller.js";
import { IosSessionCleanup } from "../../src/automation/ios-session-cleanup.js";
import { IosPhysicalSafariNavigator } from "../../src/automation/ios-physical-safari-navigator.js";
import { ServiceManager } from "../../src/infrastructure/process-manager.js";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TestbenchDefaults } from "../../src/config/defaults.js";

describe("InteractiveController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a blocked physical Safari debugger with an initial deeplink", async () => {
    vi.spyOn(TargetRegistry, "isSupported").mockReturnValue(true);
    const controller = new InteractiveController();
    const browser = { sessionId: "session-id", capabilities: { platformName: "iOS" } };
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("The remote Safari debugger did not respond to the requested command"))
      .mockResolvedValueOnce(browser);
    const close = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ServiceManager, "startAppium").mockResolvedValue({
      process: { stop, recentOutput: "" } as never,
      port: 1,
    });
    vi.spyOn(IosSessionCleanup, "run").mockResolvedValue(undefined);
    const navigate = vi.spyOn(IosPhysicalSafariNavigator, "navigate").mockResolvedValue(undefined);
    Object.assign(controller, { session: { start, close } });

    await expect(
      controller.start({
        target: "safari-ios",
        targetId: "physical-ios",
        deviceKind: "physical",
        platformVersion: "16.7.11",
        udid: "DEVICE-ID",
        url: "https://example.com",
      }),
    ).resolves.toMatchObject({ sessionId: "session-id", url: "https://example.com" });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ initialUrl: "http://127.0.0.1:8100/health" });
    expect(navigate).toHaveBeenCalledWith(1, "session-id", "https://example.com", expect.any(Object));
    expect(close).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("uses native Safari navigation for physical iOS sessions", async () => {
    const controller = new InteractiveController();
    const execute = vi.fn().mockResolvedValue([]);
    const navigate = vi.spyOn(IosPhysicalSafariNavigator, "navigate").mockResolvedValue(undefined);
    Object.assign(controller, {
      target: { name: "safari-ios", deviceKind: "physical" },
      appium: { port: 4723 },
      session: {
        active: {
          sessionId: "session-id",
          execute,
          getUrl: vi.fn().mockResolvedValue("https://example.com"),
          getTitle: vi.fn().mockResolvedValue("Example"),
        },
      },
    });

    await controller.navigate("https://example.com");

    expect(navigate).toHaveBeenCalledWith(4723, "session-id", "https://example.com", {
      name: "safari-ios",
      deviceKind: "physical",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reports successful physical navigation when only page inspection is blocked", async () => {
    const controller = new InteractiveController();
    vi.spyOn(IosPhysicalSafariNavigator, "navigate").mockResolvedValue(undefined);
    Object.assign(controller, {
      target: { name: "safari-ios", deviceKind: "physical" },
      appium: { port: 4723 },
      session: {
        active: {
          sessionId: "session-id",
          execute: vi.fn().mockRejectedValue(new Error("The remote Safari debugger did not respond")),
        },
      },
    });

    await expect(controller.navigate("https://blocking.example")).resolves.toEqual({
      url: "https://blocking.example",
      title: "",
      elements: [],
    });
  });

  it("rejects unsupported Android full-page screenshots explicitly", async () => {
    const controller = new InteractiveController();
    Object.assign(controller, { target: { name: "chrome-android" } });

    await expect(controller.captureScreenshot(true)).rejects.toThrow(
      "Full-page screenshots are not supported by Chrome on Android",
    );
  });

  it("collects WebSocket lifecycle, handshake, frame, and error diagnostics", async () => {
    const controller = new InteractiveController();
    const performanceEntries = [
      performanceEntry("Network.webSocketCreated", {
        requestId: "socket-1",
        url: "ws://127.0.0.1/websocket",
      }),
      performanceEntry("Network.webSocketWillSendHandshakeRequest", {
        requestId: "socket-1",
        request: { headers: { Upgrade: "websocket" } },
      }),
      performanceEntry("Network.webSocketHandshakeResponseReceived", {
        requestId: "socket-1",
        response: { status: 101, statusText: "Switching Protocols", headers: { Upgrade: "websocket" } },
      }),
      performanceEntry("Network.webSocketFrameSent", {
        requestId: "socket-1",
        response: { opcode: 1, payloadData: "outgoing" },
      }),
      performanceEntry("Network.webSocketFrameReceived", {
        requestId: "socket-1",
        response: { opcode: 1, payloadData: "incoming" },
      }),
      performanceEntry("Network.webSocketFrameError", {
        requestId: "socket-1",
        errorMessage: "fixture error",
      }),
      performanceEntry("Network.webSocketClosed", { requestId: "socket-1" }),
    ];
    const logs = vi.fn(async (type: string) => (type === "performance" ? performanceEntries.splice(0) : []));
    Object.assign(controller, { session: { active: { logs } } });

    const diagnostics = await controller.diagnostics();

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "webSocket", phase: "created", requestId: "socket-1" }),
        expect.objectContaining({ type: "webSocket", phase: "handshakeRequest", url: "ws://127.0.0.1/websocket" }),
        expect.objectContaining({ type: "webSocket", phase: "handshakeResponse", status: 101 }),
        expect.objectContaining({ type: "webSocketFrame", direction: "sent", opcode: 1, body: "outgoing" }),
        expect.objectContaining({ type: "webSocketFrame", direction: "received", opcode: 1, body: "incoming" }),
        expect.objectContaining({ type: "webSocket", phase: "error", error: "fixture error" }),
        expect.objectContaining({ type: "webSocket", phase: "closed", url: "ws://127.0.0.1/websocket" }),
      ]),
    );
    controller.clearDiagnostics();
    await expect(controller.diagnostics()).resolves.toEqual([]);
  });

  it("caps diagnostic request bodies", async () => {
    const controller = new InteractiveController();
    const postData = "x".repeat(TestbenchDefaults.PAGE_SOURCE_LIMIT + 1_000);
    const logs = vi.fn(async (type: string) =>
      type === "performance"
        ? [
            performanceEntry("Network.requestWillBeSent", {
              requestId: "request-1",
              timestamp: 1,
              request: { method: "POST", url: "https://example.com", postData },
            }),
          ]
        : [],
    );
    Object.assign(controller, { session: { active: { logs } } });

    const diagnostics = await controller.diagnostics();

    expect(diagnostics[0]).toMatchObject({ type: "request", body: "x".repeat(TestbenchDefaults.PAGE_SOURCE_LIMIT) });
  });

  it("reports cleanup failures after clearing every managed resource", async () => {
    const controller = new InteractiveController();
    const stopAppium = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(IosSessionCleanup, "run").mockResolvedValue(undefined);
    Object.assign(controller, {
      session: { close: vi.fn().mockRejectedValue(new Error("browser close failed")) },
      video: { recorder: { stop: vi.fn().mockRejectedValue(new Error("video close failed")) }, path: "video.mp4" },
      appium: { process: { stop: stopAppium }, port: 1234 },
      target: { name: "chrome-android" },
    });

    await expect(controller.close()).rejects.toThrow("Session cleanup failed");

    expect(stopAppium).toHaveBeenCalledOnce();
    expect(controller).toMatchObject({ video: undefined, appium: undefined, target: undefined });
  });

  it("waits for a stalled browser close to settle after stopping Appium", async () => {
    vi.useFakeTimers();
    const controller = new InteractiveController();
    let finishBrowserClose: (() => void) | undefined;
    const browserClose = new Promise<void>((resolve) => {
      finishBrowserClose = resolve;
    });
    const stopAppium = vi.fn(async () => finishBrowserClose?.());
    vi.spyOn(IosSessionCleanup, "run").mockResolvedValue(undefined);
    Object.assign(controller, {
      session: { close: vi.fn(() => browserClose) },
      appium: { process: { stop: stopAppium }, port: 1234 },
      target: { name: "safari-ios", deviceKind: "physical", udid: "DEVICE-ID" },
    });

    const closing = controller.close();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(closing).resolves.toEqual({ videoPath: undefined });
    expect(stopAppium).toHaveBeenCalledOnce();
  });
});

function performanceEntry(method: string, params: Record<string, unknown>): { message: string; timestamp: number } {
  return { message: JSON.stringify({ message: { method, params } }), timestamp: 1_750_000_000_000 };
}
