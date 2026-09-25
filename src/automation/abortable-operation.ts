import { TestbenchError } from "../errors/testbench-error.js";

export class AbortableOperation {
  static async run<T>(
    operation: Promise<T>,
    options: { name: string; timeoutMs?: number; signal?: AbortSignal; details?: Record<string, unknown> },
  ): Promise<T> {
    const startedAt = performance.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeoutMs !== undefined) timer = setTimeout(() => controller.abort("timeout"), options.timeoutMs);
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          const rejectAborted = (): void => {
            const elapsedMs = Math.round(performance.now() - startedAt);
            const timedOut = !options.signal?.aborted;
            reject(
              new TestbenchError(
                timedOut ? "WAIT_TIMEOUT" : "OPERATION_ABORTED",
                timedOut ? `${options.name} timed out after ${options.timeoutMs} ms.` : `${options.name} was aborted.`,
                {
                  operation: options.name,
                  status: timedOut ? 408 : 499,
                  details: {
                    ...options.details,
                    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                    elapsedMs,
                  },
                },
              ),
            );
          };
          controller.signal.addEventListener("abort", rejectAborted, { once: true });
          if (options.signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      void operation.catch(() => undefined);
    }
  }
}
