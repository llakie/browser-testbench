import { randomUUID } from "node:crypto";
import type { WorkbenchEventType } from "../setup/workbench-events.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { PackageMetadata } from "../config/package-metadata.js";
import { RemoteApiClient, RemoteApiError } from "./remote-api-client.js";
import { RemoteCredentialStore } from "./remote-client-store.js";
import { RemoteCrypto, type EphemeralKeyPair } from "./remote-crypto.js";
import type {
  AuthorizedRemoteClient,
  ConnectionStatus,
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
  key: Buffer;
  expiresAt: string;
  failedAttempts: number;
}

export class RemoteConnectionService {
  private activeCredential?: RemoteClientCredential;
  private readonly pending = new Map<string, PendingConnection>();
  private heartbeat?: NodeJS.Timeout;
  private eventsAbort?: AbortController;
  private reachable?: boolean;
  private eventHandler?: (type: WorkbenchEventType) => void;

  constructor(private readonly credentials = new RemoteCredentialStore()) {}

  status(): ConnectionStatus {
    if (!this.activeCredential) return { mode: "local" };
    const { secret: _secret, ...remote } = this.activeCredential;
    return { mode: "remote", remote, reachable: this.reachable };
  }

  client(): RemoteApiClient | undefined {
    return this.activeCredential ? this.remoteClient(this.activeCredential) : undefined;
  }

  async probe(): Promise<ConnectionStatus> {
    const status = this.status();
    if (!this.activeCredential) return { ...status, reachable: true };
    try {
      await this.checkConnection();
    } catch {
      this.setReachable(false);
    }
    return this.status();
  }

  onEvent(handler: (type: WorkbenchEventType) => void): void {
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
    this.prunePending();
    const active = this.activeConnection(instance.instanceId, role);
    if (active) return active;
    if (instance.apiVersion !== 1)
      throw new Error(`Remote Testbench '${instance.name}' uses unsupported API version ${instance.apiVersion}.`);
    this.assertCompatibleProductVersion(instance);
    const saved = await this.credentials.find(instance.instanceId);
    if (saved && (saved.role === "admin" || saved.role === role)) {
      const credential = {
        ...saved,
        url: instance.url,
        instanceName: instance.name,
        platform: instance.platform,
        architecture: instance.architecture,
        version: instance.version,
      };
      try {
        const principal = await new RemoteApiClient(credential).request<{ clientId: string; role: RemoteRole }>(
          "/v1/remote/me",
          { timeoutMs: TestbenchDefaults.REMOTE_CONNECT_TIMEOUT_MS },
        );
        this.assertPrincipal(credential, principal.clientId);
        credential.role = principal.role;
        await this.credentials.save(credential);
        this.assertActivationAvailable(instance.instanceId);
        this.activeCredential = credential;
        this.reachable = true;
        this.startHeartbeat();
        this.startEvents(credential);
        return this.status();
      } catch (error) {
        if (!(error instanceof RemoteApiError) || error.status !== 401) throw error;
        await this.credentials.remove(instance.instanceId);
      }
    }
    const existing = [...this.pending.values()].find(
      (connection) => connection.instance.instanceId === instance.instanceId && connection.role === role,
    );
    if (existing) return { pairingRequired: true, pairingId: existing.pairingId, expiresAt: existing.expiresAt };
    const clientName = RemoteCredentialStore.localClientName();
    const clientId = randomUUID();
    const keys: EphemeralKeyPair = RemoteCrypto.ephemeralKeyPair();
    const response = await this.publicRequest<PairingChallenge>(instance.url, "/v1/remote/pairing", {
      method: "POST",
      body: JSON.stringify({ clientName, role, clientId, clientPublicKey: keys.publicKey }),
    });
    const pending: PendingConnection = {
      instance,
      pairingId: response.pairingId,
      clientId,
      clientName,
      role,
      key: RemoteCrypto.pairingKey(keys.ecdh, response.serverPublicKey, response.pairingId),
      expiresAt: response.expiresAt,
      failedAttempts: 0,
    };
    this.pending.set(pending.pairingId, pending);
    return { pairingRequired: true, pairingId: pending.pairingId, expiresAt: pending.expiresAt };
  }

  async completePairing(pairingId: string, code: string): Promise<ConnectionStatus> {
    this.prunePending();
    const pending = this.pending.get(pairingId);
    if (!pending) throw new Error("The local pairing request expired or was not found.");
    this.assertActivationAvailable(pending.instance.instanceId);
    if (!RemoteCrypto.equal(RemoteCrypto.pairingCode(pending.key, pairingId), code)) {
      pending.failedAttempts += 1;
      if (pending.failedAttempts >= 5) this.pending.delete(pairingId);
      throw new Error("The pairing code does not match the remote Testbench identity.");
    }
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
          proof: RemoteCrypto.proof(pending.key, pending.clientId, pending.role),
        }),
      },
    );
    const authorized = RemoteCrypto.decrypt<AuthorizedRemoteClient>(pending.key, encrypted, pairingId);
    const credential: RemoteClientCredential = {
      instanceId: pending.instance.instanceId,
      instanceName: pending.instance.name,
      platform: pending.instance.platform,
      architecture: pending.instance.architecture,
      version: pending.instance.version,
      url: pending.instance.url,
      clientId: authorized.clientId,
      clientName: authorized.name,
      role: authorized.role,
      secret: authorized.secret,
    };
    await this.credentials.save(credential);
    this.assertActivationAvailable(pending.instance.instanceId);
    this.pending.delete(pairingId);
    this.activeCredential = credential;
    this.reachable = true;
    this.startHeartbeat();
    this.startEvents(credential);
    return this.status();
  }

  async disconnect(): Promise<ConnectionStatus> {
    this.stopHeartbeat();
    this.stopEvents();
    const client = this.client();
    if (client) {
      await client
        .request("/v1/client/sessions", {
          method: "DELETE",
          timeoutMs: TestbenchDefaults.REMOTE_CLEANUP_TIMEOUT_MS,
        })
        .catch(() => undefined);
    }
    this.activeCredential = undefined;
    this.reachable = undefined;
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
      this.reachable = undefined;
      await this.credentials.remove(instanceId);
      this.eventHandler?.("connection.changed");
    }
  }

  private activeConnection(instanceId: string, role: RemoteRole): ConnectionStatus | undefined {
    if (!this.activeCredential) return undefined;
    if (
      this.activeCredential.instanceId === instanceId &&
      (this.activeCredential.role === "admin" || this.activeCredential.role === role)
    )
      return this.status();
    throw new Error(
      `Disconnect from '${this.activeCredential.instanceName}' before connecting to another Remote Testbench or changing access level.`,
    );
  }

  private assertActivationAvailable(instanceId: string): void {
    if (this.activeCredential && this.activeCredential.instanceId !== instanceId)
      throw new Error(
        `Disconnect from '${this.activeCredential.instanceName}' before activating another Remote Testbench.`,
      );
  }

  private assertCompatibleProductVersion(instance: RemoteInstance): void {
    const local = this.versionParts(PackageMetadata.VERSION);
    const remote = this.versionParts(instance.version);
    const compatible =
      local && remote && local.major === remote.major && (local.major !== 0 || local.minor === remote.minor);
    if (!compatible)
      throw new Error(
        `Remote Testbench '${instance.name}' uses incompatible product version ${instance.version}; this gateway uses ${PackageMetadata.VERSION}.`,
      );
  }

  private versionParts(version: string): { major: number; minor: number } | undefined {
    const match = version.match(/^(\d+)\.(\d+)(?:\.|$)/);
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(
      () => void this.checkConnection().catch(() => this.setReachable(false)),
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
        const response = await this.remoteClient(credential).response("/v1/events", { signal, timeoutMs: 0 });
        if (!response.ok || !response.body) throw new Error(`Remote event stream returned HTTP ${response.status}.`);
        this.setReachable(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            await this.handleEventBlock(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (signal.aborted) return;
        this.setReachable(false);
      }
      await this.retryDelay(signal);
    }
  }

  private async handleEventBlock(block: string): Promise<void> {
    const type = block
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    if (type === "environment.changed" || type === "workbench.changed") this.eventHandler?.(type);
    if (type === "connection.changed") {
      const previousRole = this.activeCredential?.role;
      try {
        await this.checkConnection();
        if (this.activeCredential?.role === previousRole) this.eventHandler?.(type);
      } catch {
        this.setReachable(false);
      }
    }
  }

  private retryDelay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const complete = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", complete);
        resolve();
      };
      const timer = setTimeout(complete, 2_000);
      timer.unref();
      signal.addEventListener("abort", complete, { once: true });
    });
  }

  private async checkConnection(): Promise<void> {
    const credential = this.activeCredential;
    if (!credential) return;
    const principal = await this.remoteClient(credential).request<{ clientId: string; role: RemoteRole }>(
      "/v1/remote/me",
      { timeoutMs: TestbenchDefaults.REMOTE_CONNECT_TIMEOUT_MS },
    );
    this.assertPrincipal(credential, principal.clientId);
    if (principal.role !== credential.role) {
      credential.role = principal.role;
      await this.credentials.save(credential);
      this.eventHandler?.("connection.changed");
    }
    this.setReachable(true);
  }

  private setReachable(reachable: boolean): void {
    if (!this.activeCredential || this.reachable === reachable) return;
    this.reachable = reachable;
    this.eventHandler?.("connection.changed");
  }

  private assertPrincipal(credential: RemoteClientCredential, clientId: string): void {
    if (clientId !== credential.clientId)
      throw new RemoteApiError("The remote Testbench rejected the saved client credential.", 401);
  }

  private remoteClient(credential: RemoteClientCredential): RemoteApiClient {
    return new RemoteApiClient(credential, () => this.revokeActive(credential.clientId));
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [pairingId, connection] of this.pending)
      if (Date.parse(connection.expiresAt) <= now) this.pending.delete(pairingId);
  }

  private async publicRequest<T>(url: string, path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TestbenchDefaults.REMOTE_CONNECT_TIMEOUT_MS),
        headers: { "content-type": "application/json", ...init.headers },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        error instanceof Error && error.name === "TimeoutError"
          ? `Remote Testbench at ${url} timed out after ${TestbenchDefaults.REMOTE_CONNECT_TIMEOUT_MS} ms.`
          : `Remote Testbench is not reachable at ${url}: ${detail}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Remote Testbench responded with HTTP ${response.status}.`);
    return payload;
  }
}
