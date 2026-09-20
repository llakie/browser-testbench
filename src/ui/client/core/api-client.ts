const authorizationStorageKey = "browser-testbench-token";
const clientVersion = document.querySelector<HTMLElement>("#app")?.dataset.version;

export class ApiClient {
  static authorization(): string {
    return sessionStorage.getItem(authorizationStorageKey) ?? "";
  }

  static headers(initial?: HeadersInit): Headers {
    const headers = new Headers(initial);
    const authorization = this.authorization();
    if (clientVersion) headers.set("x-browser-testbench-version", clientVersion);
    if (authorization) headers.set("authorization", `Bearer ${authorization}`);
    return headers;
  }

  static async request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
    const headers = this.headers(options.headers);
    if (options.body) headers.set("content-type", "application/json");
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
