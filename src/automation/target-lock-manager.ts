interface LockWaiter {
  ownerId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

export class TargetLockTimeoutError extends Error {}

export class TargetLockManager {
  private readonly queues = new Map<string, LockWaiter[]>();

  async acquire(targetId: string, timeoutMs: number, ownerId = "local"): Promise<() => void> {
    const queue = this.queues.get(targetId);
    if (!queue) {
      this.queues.set(targetId, []);
      return this.releaseOnce(targetId);
    }
    if (timeoutMs === 0) throw new TargetLockTimeoutError(`Target '${targetId}' is busy.`);
    await new Promise<void>((resolve, reject) => {
      const waiter: LockWaiter = { ownerId, resolve, reject };
      waiter.timeout = setTimeout(() => {
        const current = this.queues.get(targetId);
        const index = current?.indexOf(waiter) ?? -1;
        if (index >= 0) current!.splice(index, 1);
        reject(new TargetLockTimeoutError(`Target '${targetId}' remained busy for ${timeoutMs} ms.`));
      }, timeoutMs);
      waiter.timeout.unref();
      queue.push(waiter);
    });
    return this.releaseOnce(targetId);
  }

  isLocked(targetId: string): boolean {
    return this.queues.has(targetId);
  }

  cancelOwner(ownerId: string): void {
    for (const [targetId, queue] of this.queues) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const waiter = queue[index]!;
        if (waiter.ownerId !== ownerId) continue;
        queue.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.reject(new TargetLockTimeoutError(`The client disconnected while waiting for target '${targetId}'.`));
      }
    }
  }

  private releaseOnce(targetId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.queues.get(targetId);
      const next = queue?.shift();
      if (next) {
        clearTimeout(next.timeout);
        next.resolve();
      } else this.queues.delete(targetId);
    };
  }
}
