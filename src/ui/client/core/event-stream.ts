import type { WorkbenchEventType } from "../../../setup/workbench-events.js";
import { ApiClient } from "./api-client.js";

const reconnectDelayMs = 2_000;

export class EventStream {
  private readonly controller = new AbortController();

  constructor(private readonly onChange: (event: WorkbenchEventType) => void) {}

  start(): void {
    window.addEventListener("pagehide", () => this.stop(), { once: true });
    void this.listen();
  }

  stop(): void {
    this.controller.abort();
  }

  private async listen(): Promise<void> {
    while (!this.controller.signal.aborted) {
      document.documentElement.dataset.environmentStream = "connecting";
      try {
        const authorization = ApiClient.authorization();
        const headers = new Headers();
        if (authorization) headers.set("authorization", `Bearer ${authorization}`);
        const response = await fetch("/v1/events", { headers, signal: this.controller.signal });
        if (!response.ok || !response.body) throw new Error(`Event stream returned HTTP ${response.status}.`);
        await this.consume(response.body);
      } catch {
        if (this.controller.signal.aborted) return;
        document.documentElement.dataset.environmentStream = "reconnecting";
      }
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        this.handle(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private handle(block: string): void {
    const event = block
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    if (event === "connected") document.documentElement.dataset.environmentStream = "connected";
    if (event === "environment.changed" || event === "connection.changed" || event === "workbench.changed")
      this.onChange(event);
  }
}
