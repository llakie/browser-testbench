import type { Response } from "express";
import { TestbenchDefaults } from "../config/defaults.js";
import { WorkbenchEvents } from "../setup/workbench-events.js";

export class WorkbenchEventStream {
  private readonly connections = new Map<Response, () => void>();

  constructor(private readonly events: WorkbenchEvents) {}

  connect(response: Response): void {
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write('event: connected\ndata: {"connected":true}\n\n');
    const unsubscribe = this.events.subscribe((event) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(
      () => response.write(": keep-alive\n\n"),
      TestbenchDefaults.EVENT_HEARTBEAT_INTERVAL_MS,
    );
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.connections.delete(response);
    };
    this.connections.set(response, cleanup);
    response.on("close", cleanup);
  }

  close(): void {
    for (const [response, cleanup] of this.connections) {
      cleanup();
      response.end();
    }
    this.connections.clear();
  }
}
