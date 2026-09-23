import type { RemoteSession } from "./testbench-client.js";

export class McpSessionCoordinator {
  private current?: RemoteSession;
  private operations: Promise<void> = Promise.resolve();

  active(): RemoteSession {
    if (!this.current) throw new Error("No interactive session is active.");
    return this.current;
  }

  activeId(): string | undefined {
    return this.current?.id;
  }

  replace(start: () => Promise<RemoteSession>): Promise<RemoteSession> {
    return this.exclusive(async () => {
      await this.closeCurrent();
      this.current = await start();
      return this.current;
    });
  }

  close(): Promise<{ videoPath?: string }> {
    return this.exclusive(() => this.closeCurrent());
  }

  transition<T>(operation: () => Promise<T>, options: { ignoreCloseError?: boolean } = {}): Promise<T> {
    return this.exclusive(async () => {
      if (options.ignoreCloseError) await this.closeCurrent().catch(() => undefined);
      else await this.closeCurrent();
      return operation();
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async closeCurrent(): Promise<{ videoPath?: string }> {
    if (!this.current) return {};
    const session = this.current;
    this.current = undefined;
    return session.close();
  }
}
