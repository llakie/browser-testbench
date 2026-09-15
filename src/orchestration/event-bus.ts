import { EventEmitter } from "node:events";
import type { TestbenchEvent } from "../config/types.js";

export class TestbenchEventBus extends EventEmitter {
  publish(event: Omit<TestbenchEvent, "timestamp">): void {
    this.emit("event", { ...event, timestamp: new Date().toISOString() } satisfies TestbenchEvent);
  }

  subscribe(listener: (event: TestbenchEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

export const eventBus = new TestbenchEventBus();
