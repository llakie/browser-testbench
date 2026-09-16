export class TargetLockManager {
  private readonly queues = new Map<string, Array<() => void>>();

  async acquire(targetId: string): Promise<() => void> {
    const queue = this.queues.get(targetId);
    if (!queue) {
      this.queues.set(targetId, []);
      return this.releaseOnce(targetId);
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    return this.releaseOnce(targetId);
  }

  private releaseOnce(targetId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.queues.get(targetId);
      const next = queue?.shift();
      if (next) next();
      else this.queues.delete(targetId);
    };
  }
}
