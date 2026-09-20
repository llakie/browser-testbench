import { TestbenchDefaults } from "../config/defaults.js";

interface AppiumResponse<T> {
  value: T | { error?: string; message?: string };
}

export class AppiumCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class AppiumSessionClient {
  private readonly baseUrl: string;

  constructor(port: number, sessionId: string) {
    this.baseUrl = `http://${TestbenchDefaults.LOOPBACK_HOST}:${port}/session/${sessionId}`;
  }

  async request<T = null>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, unknown>,
    timeoutMs = TestbenchDefaults.IOS_NATIVE_NAVIGATION_TIMEOUT_MS,
  ): Promise<T> {
    const url = `${this.baseUrl}/${path.replace(/^\//u, "")}`;
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const payload = (await response.json().catch(() => ({ value: null }))) as AppiumResponse<T>;
    const error = payload.value as { error?: string; message?: string } | null;
    const hasError = typeof error?.error === "string";
    if (!response.ok || hasError) {
      throw new AppiumCommandError(
        (hasError ? error.message : undefined) ?? `Appium returned HTTP ${response.status} for ${method} ${url}.`,
        hasError ? error.error : undefined,
      );
    }
    return payload.value as T;
  }
}
