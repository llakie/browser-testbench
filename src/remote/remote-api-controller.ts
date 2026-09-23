import type { Express, NextFunction, Request, Response } from "express";
import { InputSchemas, type StartSessionInput } from "../config/input-schemas.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { PackageMetadata } from "../config/package-metadata.js";
import { TargetRegistry } from "../config/target-registry.js";
import { McpIntegrationService } from "../setup/mcp-integration-service.js";
import { RemoteArtifactGateway } from "./remote-artifact-transfer.js";
import { RemoteApiError } from "./remote-api-client.js";
import { AuthorizedRemoteClientStore, RemoteHostIdentityStore } from "./remote-client-store.js";
import { RemoteConnectionService } from "./remote-connection-service.js";
import type { RemoteDiscoveryBrowser } from "./remote-discovery-service.js";
import { RemotePairingService } from "./remote-pairing-service.js";
import { RemoteRequestAuthentication } from "./remote-request-authentication.js";
import { RemoteUrlGuard } from "./remote-url-guard.js";
import { ErrorResponse, type ErrorResponsePayload } from "../i18n/error-response.js";
import { RequestAbort } from "../transports/request-abort.js";

interface RemoteApiControllerOptions {
  remote: boolean;
  identity: RemoteHostIdentityStore;
  clients: AuthorizedRemoteClientStore;
  pairing: RemotePairingService;
  authentication: RemoteRequestAuthentication;
  discovery: Pick<RemoteDiscoveryBrowser, "discover">;
  connections: RemoteConnectionService;
  notifyConnectionChanged: () => void;
  closeOwned: (ownerId: string) => Promise<void>;
  isClientConnected: (clientId: string) => boolean;
}

export class RemoteApiController {
  readonly artifacts = new RemoteArtifactGateway();

  constructor(private readonly options: RemoteApiControllerOptions) {}

  registerPairingRoutes(app: Express): void {
    app.get("/v1/remote/identity", async (_request, response) => {
      if (!this.options.remote) return this.remoteDisabled(response);
      response.json({
        instanceId: await this.options.identity.instanceId(),
        name: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "Browser Testbench",
        platform: process.platform,
        architecture: process.arch,
        version: PackageMetadata.VERSION,
        apiVersion: 1,
        authentication: "pairing",
      });
    });
    app.post("/v1/remote/pairing", (request, response) => {
      if (!this.options.remote) return this.remoteDisabled(response);
      const input = InputSchemas.remotePairingBegin.parse(request.body);
      const pairing = this.options.pairing.begin(input.clientName, input.role, input.clientId, input.clientPublicKey);
      this.options.notifyConnectionChanged();
      response.status(201).json(pairing);
    });
    app.post("/v1/remote/pairing/complete", async (request, response) => {
      if (!this.options.remote) return this.remoteDisabled(response);
      const credential = await this.options.pairing.complete(InputSchemas.remotePairingComplete.parse(request.body));
      this.options.notifyConnectionChanged();
      response.json(credential);
    });
  }

  registerConnectionRoutes(app: Express): void {
    app.get("/v1/connections/status", async (_request, response) =>
      response.json(await this.options.connections.probe()),
    );
    app.get("/v1/connections/discover", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      response.json(await this.options.discovery.discover());
    });
    app.get("/v1/connections/identity", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const server = typeof request.query.server === "string" ? request.query.server : "";
      response.json(InputSchemas.remoteInstance.parse(await this.options.connections.identity(server)));
    });
    app.post("/v1/connections/connect", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const input = InputSchemas.remoteConnect.parse(request.body);
      await this.closeLocalSessions();
      const result = await this.options.connections.connect(input.instance, input.role);
      this.options.notifyConnectionChanged();
      response.json(result);
    });
    app.post("/v1/connections/pair", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const input = InputSchemas.localPairingComplete.parse(request.body);
      await this.closeLocalSessions();
      const result = await this.options.connections.completePairing(input.pairingId, input.code);
      this.options.notifyConnectionChanged();
      response.json(result);
    });
    app.delete("/v1/connections/active", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const result = await this.options.connections.disconnect();
      this.artifacts.clear();
      this.options.notifyConnectionChanged();
      response.json(result);
    });
    this.registerClientRoutes(app);
  }

  async proxy(request: Request, response: Response, next: NextFunction): Promise<void> {
    const client = this.options.remote ? undefined : this.options.connections.client();
    if (!client || !this.isExecutionPath(request.path)) {
      next();
      return;
    }
    if (request.path === "/v1/workbench") {
      const [remoteState, mcpClients] = await Promise.all([
        client.request<Record<string, unknown>>(request.originalUrl),
        McpIntegrationService.statuses(),
      ]);
      response.json({
        ...remoteState,
        mcpClients,
        localNetworkAddress: RemoteUrlGuard.lanAddress(),
        connection: { ...this.options.connections.status(), reachable: true },
        permissions: { control: true, configure: this.options.connections.status().remote?.role === "admin" },
        remoteMode: false,
        pairingRequests: [],
      });
      return;
    }
    if (request.path === "/v1/sessions" || request.path.endsWith("/navigate"))
      RemoteUrlGuard.assertReachableFromRemote((request.body as { url?: unknown } | undefined)?.url);
    const originalBody = request.body as Record<string, unknown> | undefined;
    let path = request.originalUrl;
    let proxyBody: unknown = originalBody && Object.keys(originalBody).length > 0 ? originalBody : undefined;
    if (request.method === "POST" && request.path === "/v1/sessions")
      proxyBody = this.artifacts.prepareSession(InputSchemas.startSession.parse(originalBody));
    const sessionMatch = request.path.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
    let upload: Awaited<ReturnType<RemoteArtifactGateway["uploadRequest"]>> | undefined;
    if (request.method === "POST" && sessionMatch?.[2] === "element" && originalBody?.action === "upload") {
      path = `/v1/sessions/${sessionMatch[1]}/upload`;
      upload = await this.artifacts.uploadRequest(originalBody as unknown as { selector: string; paths: string[] });
      proxyBody = undefined;
    }
    const body = proxyBody === undefined ? undefined : JSON.stringify(proxyBody);
    const mobileSessionRequest =
      (request.path === "/v1/sessions" || request.path === "/v1/verify") &&
      typeof originalBody?.target === "string" &&
      TargetRegistry.isMobileTargetId(originalBody.target);
    const remoteRequest = {
      method: request.method,
      body: upload ? (upload.body as unknown as BodyInit) : body,
      bodyHash: upload?.bodyHash,
      headers: upload ? { "content-type": "application/octet-stream" } : undefined,
      signal: RequestAbort.signal(request, response),
      ...(request.path === "/v1/workbench/setup" ? { timeoutMs: TestbenchDefaults.SETUP_REQUEST_TIMEOUT_MS } : {}),
      ...(mobileSessionRequest ? { timeoutMs: TestbenchDefaults.MOBILE_SESSION_REQUEST_TIMEOUT_MS } : {}),
    };
    if (sessionMatch?.[2] === "browser" && originalBody?.action === "waitDownload") {
      const remoteResponse = await client.response(path, remoteRequest);
      await this.assertRemoteResponse(remoteResponse);
      response.json(await this.artifacts.receiveDownload(sessionMatch[1]!, remoteResponse));
      return;
    }
    if (request.method === "DELETE" && sessionMatch && !sessionMatch[2]) {
      try {
        const remoteResponse = await client.response(path, remoteRequest);
        await this.assertRemoteResponse(remoteResponse);
        response.json(await this.artifacts.receiveClose(sessionMatch[1]!, remoteResponse));
        return;
      } finally {
        this.artifacts.forgetSession(sessionMatch[1]!);
      }
    }
    const result = await client.request(path, remoteRequest);
    this.artifacts.assertInlineArtifact(result);
    if (request.method === "POST" && request.path === "/v1/sessions") {
      const sessionId = (result as { id: string }).id;
      this.artifacts.trackSession(sessionId, originalBody as unknown as StartSessionInput);
    }
    response.status(request.method === "POST" && request.path === "/v1/sessions" ? 201 : 200).json(result);
  }

  async workbenchContext(request: Request): Promise<Record<string, unknown>> {
    const principal = this.options.authentication.principal(request);
    return {
      localNetworkAddress: RemoteUrlGuard.lanAddress(),
      connection: this.options.connections.status(),
      permissions: { control: true, configure: !this.options.remote || principal.role === "admin" },
      remoteMode: this.options.remote,
      pairingRequests: this.options.remote && principal.local ? this.options.pairing.list() : [],
      authorizedClients: principal.role === "admin" ? await this.authorizedClients() : [],
    };
  }

  visibleHostDetails(request: Request, value: unknown): unknown {
    const principal = this.options.authentication.principal(request);
    return this.options.remote && principal.role === "control" ? this.redactInstallationPaths(value) : value;
  }

  ownerId(request: Request): string {
    return this.options.remote ? this.options.authentication.principal(request).clientId : "local";
  }

  requireAdmin(request: Request, response: Response): boolean {
    return !this.options.remote || this.options.authentication.require(request, response, "admin");
  }

  private registerClientRoutes(app: Express): void {
    app.get("/v1/remote/clients", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const remote = this.options.remote ? undefined : this.options.connections.client();
      response.json(remote ? await remote.request("/v1/remote/clients") : await this.authorizedClients());
    });
    app.get("/v1/remote/me", (request, response) => {
      const principal = this.options.authentication.principal(request);
      response.json({ clientId: principal.clientId, name: principal.name, role: principal.role });
    });
    app.put("/v1/remote/clients/:id", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const { role } = InputSchemas.remoteClientRole.parse(request.body);
      const remote = this.options.remote ? undefined : this.options.connections.client();
      if (remote) {
        const result = await remote.request(request.originalUrl, { method: "PUT", body: JSON.stringify({ role }) });
        await this.options.connections.updateActiveRole(request.params.id, role);
        response.json(result);
        return;
      }
      if (!(await this.options.clients.setRole(request.params.id, role))) {
        response.status(404).json({ error: `Remote client '${request.params.id}' was not found.` });
        return;
      }
      this.options.notifyConnectionChanged();
      response.json({ updated: true, role });
    });
    app.delete("/v1/remote/clients/:id", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const remote = this.options.remote ? undefined : this.options.connections.client();
      if (remote) {
        const result = await remote.request(request.originalUrl, { method: "DELETE" });
        await this.options.connections.revokeActive(request.params.id);
        response.json(result);
        return;
      }
      await this.options.closeOwned(request.params.id);
      if (!(await this.options.clients.revoke(request.params.id))) {
        response.status(404).json({ error: `Remote client '${request.params.id}' was not found.` });
        return;
      }
      this.options.notifyConnectionChanged();
      response.json({ revoked: true });
    });
    app.delete("/v1/client/sessions", async (request, response) => {
      await this.options.closeOwned(this.ownerId(request));
      response.json({ closed: true });
    });
  }

  private isExecutionPath(path: string): boolean {
    return (
      [
        "/v1/workbench",
        "/v1/targets",
        "/v1/doctor",
        "/v1/capabilities",
        "/v1/verify",
        "/v1/workbench/setup",
        "/v1/workbench/plan",
        "/v1/sessions",
      ].includes(path) || path.startsWith("/v1/sessions/")
    );
  }

  private async authorizedClients(): Promise<Array<Record<string, unknown>>> {
    return (await this.options.clients.list()).map((client) => ({
      ...client,
      connected: this.options.isClientConnected(client.clientId),
    }));
  }

  private async assertRemoteResponse(response: globalThis.Response): Promise<void> {
    if (response.ok) return;
    const payload = (await response.json().catch(() => ({}))) as ErrorResponsePayload;
    throw new RemoteApiError(
      ErrorResponse.message(payload, `Remote Testbench responded with HTTP ${response.status}.`),
      response.status,
    );
  }

  private async closeLocalSessions(): Promise<void> {
    if (this.options.connections.status().mode === "local") await this.options.closeOwned("local");
  }

  private redactInstallationPaths(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.redactInstallationPaths(item));
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["iosTeamId", "iosSigningId", "wdaBundleId"].includes(key))
        .map(([key, item]) => [key, this.redactInstallationPaths(item)]),
    );
    if (
      typeof result.id === "string" &&
      ["chrome", "firefox", "edge"].includes(result.id) &&
      result.status === "ready" &&
      typeof result.detail === "string"
    )
      result.detail = `${typeof result.label === "string" ? result.label : "Browser"} is installed on the remote host.`;
    return result;
  }

  private remoteDisabled(response: Response): void {
    response.status(404).json({ error: "Remote mode is not enabled." });
  }
}
