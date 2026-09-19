import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessTerminator } from "../../src/infrastructure/process-terminator.js";

describe("ProcessTerminator", () => {
  afterEach(() => vi.useRealTimers());

  it("clears its wait timer when the process closes first", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
    const waiting = ProcessTerminator.wait(child, 5_000);
    expect(vi.getTimerCount()).toBe(1);

    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0, null);

    await expect(waiting).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
