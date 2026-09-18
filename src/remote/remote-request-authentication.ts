import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { TestbenchDefaults } from "../config/defaults.js";
import { AuthorizedRemoteClientStore } from "./remote-client-store.js";
import { RemoteCrypto } from "./remote-crypto.js";
import type { RemoteClientCredential, RemotePrincipal, RemoteRole } from "./remote-types.js";

const CLIENT_HEADER = "x-browser-testbench-client";
const TIMESTAMP_HEADER = "x-browser-testbench-timestamp";
const NONCE_HEADER = "x-browser-testbench-nonce";
const SIGNATURE_HEADER = "x-browser-testbench-signature";

export class RemoteRequestSigner {
  static headers(
    credential: RemoteClientCredential,
    method: string,
    path: string,
    body: string,
  ): Record<string, string> {
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString("base64url");
    return {
      [CLIENT_HEADER]: credential.clientId,
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: RemoteCrypto.requestSignature(credential.secret, method, path, timestamp, nonce, body),
    };
  }
}

export class RemoteRequestAuthentication {
  private readonly nonces = new Map<string, number>();
  private readonly principals = new WeakMap<Request, RemotePrincipal>();

  constructor(private readonly clients: AuthorizedRemoteClientStore) {}

  private activityHandler?: (clientId: string) => void;

  onActivity(handler: (clientId: string) => void): void {
    this.activityHandler = handler;
  }

  middleware(request: Request, response: Response, next: NextFunction): void {
    if (this.isLoopback(request.socket.remoteAddress)) {
      this.principals.set(request, { clientId: "local", name: "Local user", role: "admin", local: true });
      next();
      return;
    }
    void this.authenticate(request)
      .then((principal) => {
        if (!principal) {
          response.status(401).json({ error: "Remote authentication required." });
          return;
        }
        this.principals.set(request, principal);
        next();
      })
      .catch(next);
  }

  principal(request: Request): RemotePrincipal {
    return this.principals.get(request) ?? { clientId: "local", name: "Local user", role: "admin", local: true };
  }

  require(request: Request, response: Response, role: RemoteRole): boolean {
    const principal = this.principal(request);
    if (role === "control" || principal.role === "admin") return true;
    response.status(403).json({ error: "Administrative access is required for this operation." });
    return false;
  }

  private async authenticate(request: Request): Promise<RemotePrincipal | undefined> {
    this.pruneNonces();
    const clientId = request.header(CLIENT_HEADER);
    const timestamp = request.header(TIMESTAMP_HEADER);
    const nonce = request.header(NONCE_HEADER);
    const suppliedSignature = request.header(SIGNATURE_HEADER);
    if (!clientId || !timestamp || !nonce || !suppliedSignature) return undefined;
    const requestTime = Number(timestamp);
    if (
      !Number.isFinite(requestTime) ||
      Math.abs(Date.now() - requestTime) > TestbenchDefaults.REMOTE_REQUEST_MAX_AGE_MS
    )
      return undefined;
    const nonceKey = `${clientId}:${nonce}`;
    if (this.nonces.has(nonceKey)) return undefined;
    const client = await this.clients.find(clientId);
    if (!client) return undefined;
    const body = request.body && Object.keys(request.body as object).length > 0 ? JSON.stringify(request.body) : "";
    const expected = RemoteCrypto.requestSignature(
      client.secret,
      request.method,
      request.originalUrl,
      timestamp,
      nonce,
      body,
    );
    if (!RemoteCrypto.equal(expected, suppliedSignature)) return undefined;
    this.nonces.set(nonceKey, Date.now());
    void this.clients.touch(clientId);
    this.activityHandler?.(clientId);
    return { clientId, name: client.name, role: client.role, local: false };
  }

  private pruneNonces(): void {
    const cutoff = Date.now() - TestbenchDefaults.REMOTE_REQUEST_MAX_AGE_MS;
    for (const [nonce, usedAt] of this.nonces) if (usedAt < cutoff) this.nonces.delete(nonce);
  }

  private isLoopback(address?: string): boolean {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }
}
