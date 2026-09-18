import { randomUUID } from "node:crypto";
import { TestbenchDefaults } from "../config/defaults.js";
import { RemoteApiClient, RemoteApiError } from "./remote-api-client.js";
import { RemoteCredentialStore } from "./remote-client-store.js";
import { RemoteCrypto, type EphemeralKeyPair } from "./remote-crypto.js";
import type {
  AuthorizedRemoteClient,
  EncryptedCredential,
  PairingChallenge,
  RemoteClientCredential,
  RemoteInstance,
  RemoteRole,
} from "./remote-types.js";

interface PendingConnection {
  instance: RemoteInstance;
  pairingId: string;
  clientId: string;
  clientName: string;
  role: RemoteRole;
  keys: EphemeralKeyPair;
  serverPublicKey: string;
  expiresAt: string;
}

export interface ConnectionStatus {
  mode: "local" | "remote";
  remote?: Omit<RemoteClientCredential, "secret">;
  reachable?: boolean;
}

export class RemoteConnectionService {
  private activeCredential?: RemoteClientCredential;
  private readonly pending = new Map<string, PendingConnection>();
  private heartbeat?: NodeJS.Timeout;
  private eventsAbort?: AbortController;
  private eventHandler?: (type: "environment.changed" | "connection.changed") => void;

  constructor(private readonly credentials = new RemoteCredentialStore()) {}

  status(): ConnectionStatus {
    if (!this.activeCredential) return { mode: "local" };
    const { secret: _secret, ...remote } = this.activeCredential;
    return { mode: "remote", remote };
  }

  client(): RemoteApiClient | undefined {
    return this.activeCredential ? new RemoteApiClient(this.activeCredential) : undefined;
  }

  async probe(): Promise<ConnectionStatus> {
    const status = this.status();
    if (!this.activeCredential) return { ...status, reachable: true };
    try {
      await this.client()!.request("/health");
      return { ...status, reachable: true };
    } catch {
      return { ...status, reachable: false };
    }
  }

  onEvent(handler: (type: "environment.changed" | "connection.changed") => void): void {
    this.eventHandler = handler;
  }

  async identity(url: string): Promise<RemoteInstance> {
    const normalized = url.replace(/\/$/, "");
    const identity = await this.publicRequest<Omit<RemoteInstance, "url">>(normalized, "/v1/remote/identity", {
      method: "GET",
    });
    return { ...identity, url: normalized };
  }

  async connect(
    instance: RemoteInstance,
    role: RemoteRole = "control",
  ): Promise<ConnectionStatus | { pairingRequired: true; pairingId: string; expiresAt: string }> {
    if (instance.apiVersion !== 1)
      throw new Error(`Remote Testbench '${instance.name}' uses unsupported API version ${instance.apiVersion}.`);
    const saved = await this.credentials.find(instance.instanceId);
    if (saved && (saved.role === "admin" || saved.role === role)) {
      const credential = { ...saved, url: instance.url, instanceName: instance.name };
      try {
        const principal = await new RemoteApiClient(credential).request<{ clientId: string; role: RemoteRole }>(
          "/v1/remote/me",
        );
        if (principal.clientId === credential.clientId) credential.role = principal.role;
        await this.credentials.save(credential);
        this.activeCredential = credential;
        this.startHeartbeat();
        this.startEvents(credential);
        return this.status();
      } catch (error) {
        if (!(error instanceof RemoteApiError) || error.status !== 401) throw error;
        await this.credentials.remove(instance.instanceId);
      }
    }
    const clientName = RemoteCredentialStore.localClientName();
    const response = await this.publicRequest<PairingChallenge>(instance.url, "/v1/remote/pairing", {
      method: "POST",
      body: JSON.stringify({ clientName, role }),
    });
    const pending: PendingConnection = {
      instance,
      pairingId: response.pairingId,
      clientId: randomUUID(),
      clientName,
      role,
      keys: RemoteCrypto.ephemeralKeyPair(),
      serverPublicKey: response.serverPublicKey,
      expiresAt: response.expiresAt,
    };
    this.pending.set(pending.pairingId, pending);
    return { pairingRequired: true, pairingId: pending.pairingId, expiresAt: pending.expiresAt };
  }

  async completePairing(pairingId: string, code: string): Promise<ConnectionStatus> {
    const pending = this.pending.get(pairingId);
    if (!pending) throw new Error("The local pairing request expired or was not found.");
    const key = RemoteCrypto.pairingKey(pending.keys.ecdh, pending.serverPublicKey, code, pairingId);
    const encrypted = await this.publicRequest<EncryptedCredential>(
      pending.instance.url,
      "/v1/remote/pairing/complete",
      {
        method: "POST",
        body: JSON.stringify({
          pairingId,
          clientId: pending.clientId,
          clientName: pending.clientName,
          role: pending.role,
          clientPublicKey: pending.keys.publicKey,
          proof: RemoteCrypto.proof(key, pending.clientId, pending.role),
        }),
      },
    );
    const authorized = RemoteCrypto.decrypt<AuthorizedRemoteClient>(key, encrypted, pairingId);
    const credential: RemoteClientCredential = {
      instanceId: pending.instance.instanceId,
      instanceName: pending.instance.name,
      url: pending.instance.url,
      clientId: authorized.clientId,
      clientName: authorized.name,
      role: authorized.role,
      secret: authorized.secret,
    };
    await this.credentials.save(credential);
    this.pending.delete(pairingId);
    this.activeCredential = credential;
    this.startHeartbeat();
    this.startEvents(credential);
    return this.status();
  }

  async disconnect(): Promise<ConnectionStatus> {
    this.stopHeartbeat();
    this.stopEvents();
    const client = this.client();
    if (client) {
      await Promise.race([
        client.request("/v1/client/sessions", { method: "DELETE" }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, TestbenchDefaults.REMOTE_CLEANUP_TIMEOUT_MS)),
      ]);
    }
    this.activeCredential = undefined;
    return this.status();
  }

  async updateActiveRole(clientId: string, role: RemoteRole): Promise<void> {
    if (this.activeCredential?.clientId !== clientId) return;
    this.activeCredential.role = role;
    await this.credentials.save(this.activeCredential);
  }

  async revokeActive(clientId: string): Promise<void> {
    if (this.activeCredential?.clientId === clientId) {
      const instanceId = this.activeCredential.instanceId;
      this.stopHeartbeat();
      this.stopEvents();
      this.activeCredential = undefined;
      await this.credentials.remove(instanceId);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(
      () =>
        void this.client()
          ?.request("/health")
          .catch(() => undefined),
      TestbenchDefaults.REMOTE_HEARTBEAT_INTERVAL_MS,
    );
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private startEvents(credential: RemoteClientCredential): void {
    this.stopEvents();
    const controller = new AbortController();
    this.eventsAbort = controller;
    void this.consumeEvents(credential, controller.signal);
  }

  private stopEvents(): void {
    this.eventsAbort?.abort();
    this.eventsAbort = undefined;
  }

  private async consumeEvents(credential: RemoteClientCredential, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.activeCredential?.clientId === credential.clientId) {
      try {
        const response = await new RemoteApiClient(credential).response("/v1/events", { signal });
        if (!response.ok || !response.body) throw new Error(`Remote event stream returned HTTP ${response.status}.`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            this.handleEventBlock(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  private handleEventBlock(block: string): void {
    const type = block
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    if (type === "environment.changed" || type === "connection.changed") this.eventHandler?.(type);
  }

  private async publicRequest<T>(url: string, path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Remote Testbench responded with HTTP ${response.status}.`);
    return payload;
  }
}
