import { describe, expect, it, vi } from "vitest";
import { McpSessionCoordinator } from "../../src/transports/mcp-session-coordinator.js";
import type { RemoteSession } from "../../src/transports/testbench-client.js";

describe("McpSessionCoordinator", () => {
  it("serializes concurrent session replacements without orphaning a session", async () => {
    const coordinator = new McpSessionCoordinator();
    const first = session("first");
    const second = session("second");

    await Promise.all([
      coordinator.replace(async () => first.session),
      coordinator.replace(async () => second.session),
    ]);

    expect(first.close).toHaveBeenCalledOnce();
    expect(coordinator.active().id).toBe("second");
    await coordinator.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("can continue a transition while reporting a close failure", async () => {
    const coordinator = new McpSessionCoordinator();
    const current = session("current");
    current.close.mockRejectedValue(new Error("cleanup failed"));
    await coordinator.replace(async () => current.session);
    const onCloseError = vi.fn();
    const operation = vi.fn().mockResolvedValue("disconnected");

    await expect(coordinator.transition(operation, { onCloseError })).resolves.toBe("disconnected");

    expect(onCloseError).toHaveBeenCalledWith(expect.objectContaining({ message: "cleanup failed" }));
    expect(operation).toHaveBeenCalledOnce();
  });
});

function session(id: string): { session: RemoteSession; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue({ closed: true });
  return { session: { id, close } as unknown as RemoteSession, close };
}
