import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetVerificationService } from "../../src/setup/target-verification-service.js";
import { TargetCatalogService } from "../../src/setup/target-catalog-service.js";
import { VerificationStore } from "../../src/setup/verification-store.js";
import { FixtureServer } from "../../src/support/fixture-server.js";
import type { SessionManager } from "../../src/automation/session-manager.js";

describe("TargetVerificationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not report a passed verification when session cleanup fails", async () => {
    vi.spyOn(FixtureServer.prototype, "start").mockResolvedValue("http://127.0.0.1:1234");
    vi.spyOn(FixtureServer.prototype, "stop").mockResolvedValue();
    vi.spyOn(TargetCatalogService, "resolve").mockResolvedValue({ config: { name: "chrome" } } as never);
    const record = vi.spyOn(VerificationStore, "record").mockResolvedValue();
    const sessions = {
      start: vi.fn().mockResolvedValue({ id: "verification", runtime: {} }),
      get: vi.fn().mockReturnValue({
        elementAction: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    } as unknown as SessionManager;

    await expect(TargetVerificationService.run(sessions, { target: "chrome" })).rejects.toThrow("cleanup failed");
    expect(record).not.toHaveBeenCalled();
    expect(FixtureServer.prototype.stop).toHaveBeenCalledOnce();
  });
});
