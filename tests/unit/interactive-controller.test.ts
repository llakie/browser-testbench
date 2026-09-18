import { describe, expect, it, vi } from "vitest";
import { InteractiveController } from "../../src/automation/interactive-controller.js";

describe("InteractiveController", () => {
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
});

function performanceEntry(method: string, params: Record<string, unknown>): { message: string; timestamp: number } {
  return { message: JSON.stringify({ message: { method, params } }), timestamp: 1_750_000_000_000 };
}
