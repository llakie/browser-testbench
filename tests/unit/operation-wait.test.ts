import { describe, expect, it, vi } from "vitest";
import { OperationWait } from "../../src/automation/operation-wait.js";
import { TestbenchError } from "../../src/errors/testbench-error.js";

describe("OperationWait", () => {
  it("returns when the condition becomes true", async () => {
    const condition = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await OperationWait.until(condition, { operation: "wait.element", timeoutMs: 1_000, intervalMs: 1 });

    expect(condition).toHaveBeenCalledTimes(2);
  });

  it("reports timeout details and the last known cause", async () => {
    const error = await OperationWait.until(() => Promise.reject(new Error("driver unavailable")), {
      operation: "wait.element",
      timeoutMs: 5,
      intervalMs: 1,
      details: { selector: "#result" },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(TestbenchError);
    expect(error).toMatchObject({
      code: "WAIT_TIMEOUT",
      operation: "wait.element",
      details: { selector: "#result", timeoutMs: 5, lastCause: "driver unavailable" },
    });
    expect(error.details.elapsedMs).toBeGreaterThanOrEqual(5);
  });

  it("stops polling when aborted", async () => {
    const controller = new AbortController();
    const condition = vi.fn().mockResolvedValue(false);
    setTimeout(() => controller.abort(), 5);

    const error = await OperationWait.until(condition, {
      operation: "wait.text",
      timeoutMs: 1_000,
      intervalMs: 100,
      signal: controller.signal,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "OPERATION_ABORTED", operation: "wait.text" });
    expect(condition.mock.calls.length).toBeLessThan(3);
  });
});
