export class LiveReloadClient {
  static start(enabled: boolean): void {
    if (!enabled) return;
    const updates = new EventSource("/ui-live-reload");
    updates.addEventListener("message", () => window.location.reload());
    window.addEventListener("pagehide", () => updates.close(), { once: true });
  }
}
