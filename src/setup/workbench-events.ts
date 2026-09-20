export type WorkbenchEventType = "environment.changed" | "connection.changed" | "workbench.changed";

export interface WorkbenchEvent {
  type: WorkbenchEventType;
  source: "android" | "ios" | "remote" | "session" | "setup" | "mcp";
  occurredAt: string;
}

export class WorkbenchEvents {
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>();

  publish(event: WorkbenchEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }
}
