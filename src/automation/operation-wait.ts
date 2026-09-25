import { setTimeout as delay } from "node:timers/promises";
import { TestbenchError } from "../errors/testbench-error.js";

export interface OperationWaitOptions {
  operation: string;
  timeoutMs: number;
  signal?: AbortSignal;
  details?: Record<string, unknown>;
  intervalMs?: number;
}

export class OperationWait {
  static async until(condition: () => Promise<boolean>, options: OperationWaitOptions): Promise<void> {
    const startedAt = performance.now();
    let lastError: unknown;
    for (;;) {
      this.throwIfAborted(options);
      try {
        if (await condition()) return;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= options.timeoutMs) {
        throw new TestbenchError("WAIT_TIMEOUT", `${options.operation} timed out after ${options.timeoutMs} ms.`, {
          operation: options.operation,
          status: 408,
          cause: lastError,
          details: {
            ...options.details,
            timeoutMs: options.timeoutMs,
            elapsedMs: Math.round(elapsedMs),
            ...(lastError instanceof Error ? { lastCause: lastError.message } : {}),
          },
        });
      }
      try {
        await delay(Math.min(options.intervalMs ?? 100, options.timeoutMs - elapsedMs), undefined, {
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) this.throwIfAborted(options);
        throw error;
      }
    }
  }

  static throwIfAborted(options: Pick<OperationWaitOptions, "operation" | "signal" | "details">): void {
    if (!options.signal?.aborted) return;
    throw new TestbenchError("OPERATION_ABORTED", `${options.operation} was aborted.`, {
      operation: options.operation,
      status: 499,
      details: options.details,
      cause: options.signal.reason,
    });
  }
}
