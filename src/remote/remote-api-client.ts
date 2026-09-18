import { RemoteRequestSigner } from "./remote-request-authentication.js";
import type { RemoteClientCredential } from "./remote-types.js";

export class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class RemoteApiClient {
  constructor(private readonly credential: RemoteClientCredential) {}

  async response(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    try {
      return await fetch(`${this.credential.url}${path}`, {
        ...init,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...RemoteRequestSigner.headers(this.credential, method, path, body),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(
        `Remote Testbench '${this.credential.instanceName}' is not reachable: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(path, init);
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok)
      throw new RemoteApiError(
        payload.error ?? `Remote Testbench responded with HTTP ${response.status}.`,
        response.status,
      );
    return payload;
  }
}
