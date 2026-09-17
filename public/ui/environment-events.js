const eventReconnectDelayMs = 2_000;

class EnvironmentEventStream {
  static async listen({ authorization, onEnvironmentChanged }) {
    const controller = new AbortController();
    window.addEventListener("pagehide", () => controller.abort(), { once: true });
    while (!controller.signal.aborted) {
      document.documentElement.dataset.environmentStream = "connecting";
      try {
        const token = authorization();
        const headers = token ? { authorization: `Bearer ${token}` } : {};
        const response = await fetch("/v1/events", { headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`Event stream returned HTTP ${response.status}.`);
        await this.consume(response.body, onEnvironmentChanged, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        document.documentElement.dataset.environmentStream = "reconnecting";
      }
      await new Promise((resolve) => setTimeout(resolve, eventReconnectDelayMs));
    }
  }

  static async consume(body, onEnvironmentChanged, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        this.handle(buffer.slice(0, boundary), onEnvironmentChanged);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  static handle(block, onEnvironmentChanged) {
    const event = block
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    if (event === "connected") document.documentElement.dataset.environmentStream = "connected";
    if (event === "environment.changed") onEnvironmentChanged();
  }
}

window.EnvironmentEventStream = EnvironmentEventStream;
