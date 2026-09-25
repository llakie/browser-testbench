import { describe, expect, it } from "vitest";
import { AbortableOperation } from "../../src/automation/abortable-operation.js";

describe("AbortableOperation", () => {
  it("rejects an already aborted operation consistently", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      AbortableOperation.run(new Promise(() => undefined), {
        name: "navigate",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED", operation: "navigate" });
  });

  it("reports an operation timeout with elapsed time", async () => {
    await expect(
      AbortableOperation.run(new Promise(() => undefined), { name: "navigate", timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: expect.objectContaining({ timeoutMs: 5 }) });
  });
});
