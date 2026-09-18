import type { Express, NextFunction, Request, Response } from "express";
import type { SessionManager } from "../automation/session-manager.js";
import { InputSchemas, type StartSessionInput } from "../config/input-schemas.js";
import { PackageMetadata } from "../config/package-metadata.js";
import { McpIntegrationService } from "../setup/mcp-integration-service.js";
import { RemoteArtifactGateway } from "./remote-artifact-transfer.js";
import { AuthorizedRemoteClientStore, RemoteHostIdentityStore } from "./remote-client-store.js";
import { RemoteConnectionService } from "./remote-connection-service.js";
import type { RemoteDiscoveryBrowser } from "./remote-discovery-service.js";
import { RemotePairingService } from "./remote-pairing-service.js";
import { RemoteRequestAuthentication } from "./remote-request-authentication.js";
import { RemoteUrlGuard } from "./remote-url-guard.js";

interface RemoteApiControllerOptions {
  remote: boolean;
  identity: RemoteHostIdentityStore;
  clients: AuthorizedRemoteClientStore;
  pairing: RemotePairingService;
  authentication: RemoteRequestAuthentication;
  discovery: Pick<RemoteDiscoveryBrowser, "discover">;
  connections: RemoteConnectionService;
  sessions: SessionManager;
  notifyConnectionChanged: () => void;
  closeOwned: (ownerId: string) => Promise<void>;
}

export class RemoteApiController {
  readonly artifacts = new RemoteArtifactGateway();

  constructor(private readonly options: RemoteApiControllerOptions) {}

  registerPairingRoutes(app: Express): void {
    app.get("/v1/remote/identity", async (_request, response) => {
      response.json({
        instanceId: await this.options.identity.instanceId(),
        name: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "Browser Testbench",
        platform: process.platform,
        architecture: process.arch,
        version: PackageMetadata.VERSION,
        apiVersion: 1,
      });
    });
    app.post("/v1/remote/pairing", (request, response) => {
      if (!this.options.remote) return this.remoteDisabled(response);
      const input = InputSchemas.remotePairingBegin.parse(request.body);
      const pairing = this.options.pairing.begin(input.clientName, input.role);
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
      const result = await this.options.connections.connect(input.instance, input.role);
      this.options.notifyConnectionChanged();
      response.json(result);
    });
    app.post("/v1/connections/pair", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const input = InputSchemas.localPairingComplete.parse(request.body);
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
    if (request.method === "POST" && sessionMatch?.[2] === "element" && originalBody?.action === "upload") {
      path = `/v1/sessions/${sessionMatch[1]}/upload`;
      proxyBody = await this.artifacts.uploadBody(originalBody as unknown as { selector: string; paths: string[] });
    }
    const body = proxyBody === undefined ? undefined : JSON.stringify(proxyBody);
    let result = await client.request(path, { method: request.method, body });
    if (request.method === "POST" && request.path === "/v1/sessions") {
      const sessionId = (result as { id: string }).id;
      this.artifacts.trackSession(sessionId, originalBody as unknown as StartSessionInput);
    }
    if (sessionMatch?.[2] === "browser" && originalBody?.action === "waitDownload")
      result = await this.artifacts.receiveDownload(sessionMatch[1]!, result);
    if (request.method === "DELETE" && sessionMatch && !sessionMatch[2])
      result = await this.artifacts.receiveClose(sessionMatch[1]!, result);
    response.status(request.method === "POST" && request.path === "/v1/sessions" ? 201 : 200).json(result);
  }

  async workbenchContext(request: Request): Promise<Record<string, unknown>> {
    const principal = this.options.authentication.principal(request);
    return {
      connection: this.options.connections.status(),
      permissions: { control: true, configure: !this.options.remote || principal.role === "admin" },
      remoteMode: this.options.remote,
      pairingRequests: this.options.remote && principal.local ? this.options.pairing.list() : [],
      authorizedClients: principal.role === "admin" ? await this.options.clients.list() : [],
    };
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
      response.json(remote ? await remote.request("/v1/remote/clients") : await this.options.clients.list());
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
        "/v1/sessions",
      ].includes(path) || path.startsWith("/v1/sessions/")
    );
  }

  private remoteDisabled(response: Response): void {
    response.status(404).json({ error: "Remote mode is not enabled." });
  }
}
