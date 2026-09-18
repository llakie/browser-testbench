export interface WorkbenchEvent {
  type: "environment.changed" | "connection.changed";
  source: "android" | "remote";
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
