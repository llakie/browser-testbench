import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveController } from "../../src/automation/interactive-controller.js";
import { SessionManager } from "../../src/automation/session-manager.js";
import { TargetCatalogService } from "../../src/setup/target-catalog-service.js";

describe("SessionManager", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    new Error("invalid session id"),
    new Error("The session is either terminated or not started"),
    Object.assign(new Error("driver stopped"), { name: "NoSuchSessionError" }),
  ])("recognizes terminated WebDriver sessions", (error) => {
    expect(SessionManager.isTerminatedSessionError(error)).toBe(true);
  });

  it("does not discard sessions for ordinary command failures", () => {
    expect(SessionManager.isTerminatedSessionError(new Error("element not interactable"))).toBe(false);
  });

  it("isolates clients and waits for every owned session to close before reporting an error", async () => {
    vi.spyOn(TargetCatalogService, "sessionOptions").mockImplementation(
      async (input) =>
        ({
          target: { id: input.target, serial: true },
          options: {},
        }) as never,
    );
    vi.spyOn(InteractiveController.prototype, "start").mockResolvedValue({});
    const close = vi
      .spyOn(InteractiveController.prototype, "close")
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockResolvedValue({});
    const sessions = new SessionManager();
    await sessions.start({ target: "device-a" }, "client-a");
    await sessions.start({ target: "device-b" }, "client-a");
    await sessions.start({ target: "device-c" }, "client-b");

    expect(sessions.list("client-a")).toHaveLength(2);
    expect(sessions.list("client-b")).toHaveLength(1);
    await expect(sessions.closeOwned("client-a")).rejects.toThrow("first close failed");
    expect(close).toHaveBeenCalledTimes(2);
    expect(sessions.isTargetBusy("device-a")).toBe(false);
    expect(sessions.isTargetBusy("device-b")).toBe(false);
    expect(sessions.list("client-b")).toHaveLength(1);
    await sessions.closeOwned("client-b");
  });
});
