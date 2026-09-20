import { RemoteRequestSigner } from "./remote-request-authentication.js";
import { TestbenchDefaults } from "../config/defaults.js";
import type { RemoteClientCredential } from "./remote-types.js";
import { ClientVersion } from "../config/client-version.js";

export interface RemoteApiRequestInit extends RequestInit {
  timeoutMs?: number;
  bodyHash?: string;
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class RemoteApiClient {
  constructor(
    private readonly credential: RemoteClientCredential,
    private readonly onUnauthorized?: () => Promise<void>,
  ) {}

  async response(path: string, init: RemoteApiRequestInit = {}): Promise<Response> {
    const { timeoutMs = TestbenchDefaults.REMOTE_REQUEST_TIMEOUT_MS, bodyHash, ...requestInit } = init;
    const method = requestInit.method ?? "GET";
    const body = typeof requestInit.body === "string" ? requestInit.body : "";
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal =
      requestInit.signal && timeoutSignal
        ? AbortSignal.any([requestInit.signal, timeoutSignal])
        : (requestInit.signal ?? timeoutSignal);
    try {
      const response = await fetch(`${this.credential.url}${path}`, {
        ...requestInit,
        signal,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          [ClientVersion.HEADER]: ClientVersion.CURRENT,
          ...RemoteRequestSigner.headers(this.credential, method, path, body, bodyHash),
          ...requestInit.headers,
        },
        ...(requestInit.body && typeof requestInit.body !== "string" ? { duplex: "half" } : {}),
      } as RequestInit);
      if (response.status === 401) await this.onUnauthorized?.();
      return response;
    } catch (error) {
      if (timeoutSignal?.aborted)
        throw new Error(`Remote Testbench '${this.credential.instanceName}' timed out after ${timeoutMs} ms.`);
      throw new Error(
        `Remote Testbench '${this.credential.instanceName}' is not reachable: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async request<T = unknown>(path: string, init: RemoteApiRequestInit = {}): Promise<T> {
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
