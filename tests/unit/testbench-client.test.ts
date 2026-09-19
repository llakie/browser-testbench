import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestTargetInfo } from "../../src/config/types.js";
import {
  BrowserOrientation,
  PinchDirection,
  RemoteTestbench,
  SwipeDirection,
} from "../../src/transports/testbench-client.js";

describe("RemoteTestbench.availableTargets", () => {
  afterEach(() => vi.unstubAllGlobals());
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
