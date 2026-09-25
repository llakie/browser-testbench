import { describe, expect, it, vi } from "vitest";
import { BrowserElement } from "../../src/automation/browser-session.js";
import { TestbenchError } from "../../src/errors/testbench-error.js";

describe("BrowserElement", () => {
  it("resolves a selector again exactly once after a stale element action", async () => {
    const first = { click: vi.fn().mockRejectedValue(new Error("stale element reference")) };
    const second = { click: vi.fn().mockResolvedValue(undefined) };
    const findElement = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const element = new BrowserElement({ findElement } as never, "#dynamic", "chrome");

    await element.click();

    expect(findElement).toHaveBeenCalledTimes(2);
    expect(first.click).toHaveBeenCalledOnce();
    expect(second.click).toHaveBeenCalledOnce();
  });

  it("does not retry non-stale action failures", async () => {
    const blocked = new Error("element click intercepted");
    const findElement = vi.fn().mockResolvedValue({ click: vi.fn().mockRejectedValue(blocked) });
    const element = new BrowserElement({ findElement } as never, "#covered", "chrome");

    await expect(element.click()).rejects.toBe(blocked);
    expect(findElement).toHaveBeenCalledOnce();
  });

  it("reports selector, action, target and original message when the retry remains stale", async () => {
    const findElement = vi
      .fn()
      .mockResolvedValueOnce({ click: vi.fn().mockRejectedValue(new Error("Element does not exist in cache")) })
      .mockResolvedValueOnce({ click: vi.fn().mockRejectedValue(new Error("stale element reference")) });
    const element = new BrowserElement({ findElement } as never, "#dynamic", "android-target");

    const error = await element.click().catch((caught) => caught);

    expect(error).toBeInstanceOf(TestbenchError);
    expect(error).toMatchObject({
      code: "STALE_ELEMENT",
      operation: "element.click",
      details: {
        selector: "#dynamic",
        action: "click",
        target: "android-target",
        attempt: 2,
        originalDriverMessage: "Element does not exist in cache",
      },
    });
  });
});
