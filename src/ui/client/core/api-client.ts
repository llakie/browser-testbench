const authorizationStorageKey = "browser-testbench-token";

export class ApiClient {
  static authorization(): string {
    return sessionStorage.getItem(authorizationStorageKey) ?? "";
  }

  static async request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
    const authorization = this.authorization();
    const headers = new Headers(options.headers);
    if (options.body) headers.set("content-type", "application/json");
    if (authorization) headers.set("authorization", `Bearer ${authorization}`);
    const response = await fetch(path, { ...options, headers });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401 && payload.error === "Unauthorized" && retry) {
      const token = window.prompt("Browser Testbench bearer token:");
      if (token) {
        sessionStorage.setItem(authorizationStorageKey, token);
        window.dispatchEvent(new Event("browser-testbench:authorization-changed"));
        return this.request<T>(path, options, false);
      }
    }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload as T;
  }
}
