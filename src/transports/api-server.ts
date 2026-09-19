import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { SessionManager, SessionNotFoundError } from "../automation/session-manager.js";
import { InputSchemas } from "../config/input-schemas.js";
import { DoctorService } from "../setup/doctor-service.js";
import { SetupService } from "../setup/setup-service.js";
import { McpIntegrationService } from "../setup/mcp-integration-service.js";
import { WorkbenchService } from "../setup/workbench-service.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { UiRenderer } from "../ui/ui-renderer.js";
import { UiLiveReload } from "../ui/ui-live-reload.js";
import { TargetCatalogService, UnknownTargetError } from "../setup/target-catalog-service.js";
import { TargetVerificationService } from "../setup/target-verification-service.js";
import { AndroidDeviceMonitor } from "../setup/android-device-monitor.js";
import { WorkbenchEvents } from "../setup/workbench-events.js";
import { WorkbenchEventStream } from "./workbench-event-stream.js";
import { RemoteHostIdentityStore, AuthorizedRemoteClientStore } from "../remote/remote-client-store.js";
import {
  RemotePairingService,
  PairingNotFoundError,
  PairingRejectedError,
  PairingRateLimitError,
} from "../remote/remote-pairing-service.js";
import { RemoteRequestAuthentication } from "../remote/remote-request-authentication.js";
import { RemoteDiscoveryBrowser, RemoteDiscoveryPublisher } from "../remote/remote-discovery-service.js";
import { RemoteConnectionService } from "../remote/remote-connection-service.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { RemoteLoopbackUrlError } from "../remote/remote-url-guard.js";
import { RemoteApiError } from "../remote/remote-api-client.js";
import { RemoteArtifactHost } from "../remote/remote-artifact-transfer.js";
import { RemoteApiController } from "../remote/remote-api-controller.js";
import { RemoteSessionPolicy, RemoteSessionPolicyError } from "../remote/remote-session-policy.js";

export interface ApiServerOptions {
  host: string;
  port: number;
  token?: string;
  liveReload?: boolean;
  remote?: boolean;
}

export interface ApiServerDependencies {
  sessions?: SessionManager;
  events?: WorkbenchEvents;
  androidMonitor?: AndroidDeviceMonitor;
  identity?: RemoteHostIdentityStore;
  clients?: AuthorizedRemoteClientStore;
  pairing?: RemotePairingService;
  remoteAuthentication?: RemoteRequestAuthentication;
  discovery?: Pick<RemoteDiscoveryBrowser, "discover">;
  publisher?: Pick<RemoteDiscoveryPublisher, "start" | "stop">;
  connections?: RemoteConnectionService;
}

export class ApiServer {
  private readonly sessions: SessionManager;
  private readonly app = express();
  private readonly server: Server;
  private readonly workbench = new WorkbenchService();
  private readonly liveReload?: UiLiveReload;
  private readonly liveReloadResponses = new Set<Response>();
  private readonly events: WorkbenchEvents;
  private readonly eventStream: WorkbenchEventStream;
  private readonly androidMonitor: AndroidDeviceMonitor;
  private readonly identity: RemoteHostIdentityStore;
  private readonly clients: AuthorizedRemoteClientStore;
  private readonly pairing: RemotePairingService;
  private readonly remoteAuthentication: RemoteRequestAuthentication;
  private readonly discovery: Pick<RemoteDiscoveryBrowser, "discover">;
  private readonly publisher: Pick<RemoteDiscoveryPublisher, "start" | "stop">;
  private readonly connections: RemoteConnectionService;
  private readonly clientLeases = new Map<string, NodeJS.Timeout>();
  private readonly artifactHost = new RemoteArtifactHost();
  private readonly remoteApi: RemoteApiController;

  constructor(
    private readonly options: ApiServerOptions,
    dependencies: ApiServerDependencies = {},
  ) {
    this.sessions = dependencies.sessions ?? new SessionManager();
    this.events = dependencies.events ?? new WorkbenchEvents();
    this.identity = dependencies.identity ?? new RemoteHostIdentityStore();
    this.clients = dependencies.clients ?? new AuthorizedRemoteClientStore();
    this.pairing = dependencies.pairing ?? new RemotePairingService(this.clients);
    this.remoteAuthentication = dependencies.remoteAuthentication ?? new RemoteRequestAuthentication(this.clients);
    this.discovery = dependencies.discovery ?? new RemoteDiscoveryBrowser();
    this.publisher = dependencies.publisher ?? new RemoteDiscoveryPublisher(this.identity);
    this.connections = dependencies.connections ?? new RemoteConnectionService();
    this.remoteApi = new RemoteApiController({
      remote: Boolean(options.remote),
      identity: this.identity,
      clients: this.clients,
      pairing: this.pairing,
      authentication: this.remoteAuthentication,
      discovery: this.discovery,
      connections: this.connections,
      notifyConnectionChanged: () => this.notifyConnectionChanged(),
      closeOwned: (ownerId) => this.closeOwnedAndCleanup(ownerId),
    });
    this.eventStream = new WorkbenchEventStream(this.events);
    this.androidMonitor =
      dependencies.androidMonitor ?? new AndroidDeviceMonitor(() => this.notifyEnvironmentChanged("android"));
    this.remoteAuthentication.onActivity((clientId) => this.refreshClientLease(clientId));
    this.connections.onEvent((type) =>
      this.events.publish({ type, source: "remote", occurredAt: new Date().toISOString() }),
    );
    if (options.liveReload) {
      this.liveReload = new UiLiveReload([
        join(TestbenchPaths.projectRoot, "templates", "ui"),
        join(TestbenchPaths.projectRoot, "public", "ui"),
      ]);
    }
    this.app.disable("x-powered-by");
    this.registerPublicRoutes();
    this.app.use(express.json({ limit: "1mb" }));
    this.remoteApi.registerPairingRoutes(this.app);
    this.app.use((request, response, next) =>
      options.remote
        ? this.remoteAuthentication.middleware(request, response, next)
        : this.authorize(request, response, next),
    );
    this.remoteApi.registerConnectionRoutes(this.app);
    this.app.use((request, response, next) => this.remoteApi.proxy(request, response, next));
    this.registerRoutes();
    this.app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (error instanceof ZodError) {
        response.status(400).json({ error: "Invalid request", issues: error.issues });
        return;
      }
      if (error instanceof SessionNotFoundError || error instanceof PairingNotFoundError) {
        response.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof PairingRejectedError) {
        response.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof PairingRateLimitError) {
        response.status(429).json({ error: error.message });
        return;
      }
      if (error instanceof RemoteLoopbackUrlError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof RemoteApiError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof RemoteSessionPolicyError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof UnknownTargetError) {
        response.status(404).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    });
    this.server = createServer(this.app);
  }

  private registerPublicRoutes(): void {
    this.app.get("/", (_request, response) => response.redirect("/setup"));
    this.app.get("/setup", (_request, response) => this.sendUi(response, UiRenderer.setup(this.options.liveReload)));
    this.app.get("/targets", (_request, response) =>
      this.sendUi(response, UiRenderer.targets(this.options.liveReload)),
    );
    this.app.get("/docs", (_request, response) =>
      this.sendUi(response, UiRenderer.documentation(this.options.liveReload)),
    );
    this.app.get("/LICENSE.txt", (_request, response) =>
      response.sendFile(join(TestbenchPaths.projectRoot, "LICENSE.txt")),
    );
    this.app.get("/THIRD_PARTY_LICENSES.txt", (_request, response) =>
      response.sendFile(join(TestbenchPaths.projectRoot, "THIRD_PARTY_LICENSES.txt")),
    );
    if (this.liveReload) this.app.get("/ui-live-reload", (_request, response) => this.connectLiveReload(response));
    this.app.use(
      "/ui-assets",
      express.static(join(TestbenchPaths.projectRoot, "public", "ui"), {
        etag: !this.options.liveReload,
        lastModified: !this.options.liveReload,
        setHeaders: (response) => {
          if (this.options.liveReload) response.setHeader("Cache-Control", "no-store");
        },
      }),
    );
    this.app.use("/fontawesome", express.static(TestbenchPaths.packageDirectory("@fortawesome/fontawesome-free")));
  }

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, resolve);
    });
    this.liveReload?.start();
    this.androidMonitor.start();
    const address = this.server.address() as AddressInfo;
    try {
      if (this.options.remote) await this.publisher.start(address.port);
    } catch (error) {
      await this.stop();
      throw error;
    }
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    this.liveReload?.stop();
    this.androidMonitor.stop();
    for (const response of this.liveReloadResponses) response.end();
    this.liveReloadResponses.clear();
    this.eventStream.close();
    for (const lease of this.clientLeases.values()) clearTimeout(lease);
    this.clientLeases.clear();
    this.remoteApi.artifacts.clear();
    const cleanup = await Promise.allSettled([
      this.publisher.stop(),
      this.connections.disconnect(),
      this.sessions.closeAll(),
      this.artifactHost.cleanup(),
    ]);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private sendUi(response: Response, html: string): void {
    if (this.options.liveReload) response.setHeader("Cache-Control", "no-store");
    response.type("html").send(html);
  }

  private connectLiveReload(response: Response): void {
    response.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    response.flushHeaders();
    response.write("event: connected\ndata: ready\n\n");
    this.liveReloadResponses.add(response);
    const unsubscribe = this.liveReload!.subscribe(() => response.write("data: reload\n\n"));
    response.on("close", () => {
      unsubscribe();
      this.liveReloadResponses.delete(response);
    });
  }

  private registerRoutes(): void {
    this.app.get("/health", (_request, response) => response.json({ status: "ok" }));
    this.app.get("/v1/events", (_request, response) => this.eventStream.connect(response));
    this.app.get("/v1/targets", async (request, response) =>
      response.json(
        this.remoteApi.visibleHostDetails(
          request,
          (await TargetCatalogService.publicList()).map((target) => ({
            ...target,
            busy: target.serial && this.sessions.isTargetBusy(target.id),
          })),
        ),
      ),
    );
    this.app.get("/v1/doctor", async (request, response) =>
      response.json(this.remoteApi.visibleHostDetails(request, await DoctorService.inspect())),
    );
    this.app.get("/v1/capabilities", async (request, response) =>
      response.json(this.remoteApi.visibleHostDetails(request, await this.workbench.capabilities())),
    );
    this.app.post("/v1/verify", async (request, response) => {
      response.json(
        await TargetVerificationService.run(
          this.sessions,
          InputSchemas.verification.parse(request.body),
          this.ownerId(request),
        ),
      );
    });
    this.app.get("/v1/workbench", async (request, response) => {
      const state = await this.workbench.state();
      response.json(
        this.remoteApi.visibleHostDetails(request, {
          ...state,
          testTargets: (state.testTargets as Array<{ id: string; serial: boolean }>).map((target) => ({
            ...target,
            busy: target.serial && this.sessions.isTargetBusy(target.id),
          })),
          ...(await this.remoteApi.workbenchContext(request)),
        }),
      );
    });
    this.app.post("/v1/workbench/setup", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const input = InputSchemas.setup.parse(request.body);
      response.json(await SetupService.install(input.targets));
    });
    this.app.post("/v1/workbench/plan", async (request, response) => {
      const input = InputSchemas.setup.parse(request.body);
      response.json(this.remoteApi.visibleHostDetails(request, await SetupService.plan(input.targets)));
    });
    this.app.post("/v1/workbench/mcp", async (request, response) => {
      if (!this.requireAdmin(request, response)) return;
      const input = InputSchemas.mcpIntegration.parse(request.body);
      response.json(await McpIntegrationService.register(input.client));
    });
    this.app.get("/v1/sessions", (request, response) => response.json(this.sessions.list(this.ownerId(request))));
    this.app.post("/v1/sessions", async (request, response) => {
      const raw = { ...(request.body as Record<string, unknown>) };
      const transferArtifacts = raw.transferArtifacts === true;
      delete raw.transferArtifacts;
      const input = InputSchemas.startSession.parse(raw);
      RemoteSessionPolicy.assertStart(
        input,
        transferArtifacts,
        Boolean(this.options.remote),
        this.remoteAuthentication.principal(request),
      );
      const prepared = await this.artifactHost.prepareSession(input, transferArtifacts);
      try {
        const session = await this.sessions.start(prepared.input, this.ownerId(request));
        this.artifactHost.track(session.id, prepared.directory);
        response.status(201).json(session);
      } catch (error) {
        if (prepared.directory) await this.artifactHost.discard(prepared.directory);
        throw error;
      }
    });
    this.app.delete("/v1/sessions/:id", async (request, response) => {
      let result: { videoPath?: string };
      try {
        result = await this.sessions.close(request.params.id, this.ownerId(request));
      } catch (error) {
        await this.artifactHost.discardSession(request.params.id);
        throw error;
      }
      const artifact = await this.artifactHost.completeSession(request.params.id, result);
      if ("path" in artifact) {
        try {
          await this.sendArtifact(response, artifact);
        } finally {
          if (artifact.directory) await this.artifactHost.discard(artifact.directory);
        }
      } else {
        if (artifact.directory) await this.artifactHost.discard(artifact.directory);
        response.json({ closed: true, ...result });
      }
    });
    this.app.get("/v1/sessions/:id/inspect", async (request, response) => {
      const { limit } = InputSchemas.inspect.parse(request.query);
      response.json(
        await this.sessions.run(request.params.id, (session) => session.inspect(limit), this.ownerId(request)),
      );
    });
    this.app.get("/v1/sessions/:id/source", async (request, response) => {
      const { maxCharacters } = InputSchemas.pageSource.parse(request.query);
      response.json(
        await this.sessions.run(request.params.id, (session) => session.source(maxCharacters), this.ownerId(request)),
      );
    });
    this.app.post("/v1/sessions/:id/navigate", async (request, response) => {
      const { url } = InputSchemas.navigate.parse(request.body);
      response.json(
        await this.sessions.run(request.params.id, (session) => session.navigate(url), this.ownerId(request)),
      );
    });
    this.app.post("/v1/sessions/:id/click", async (request, response) => {
      const { selector } = InputSchemas.click.parse(request.body);
      await this.sessions.run(request.params.id, (session) => session.click(selector), this.ownerId(request));
      response.json({ clicked: selector });
    });
    this.app.post("/v1/sessions/:id/type", async (request, response) => {
      const { selector, value, clear } = InputSchemas.type.parse(request.body);
      await this.sessions.run(
        request.params.id,
        (session) => session.type(selector, value, clear),
        this.ownerId(request),
      );
      response.json({ typed: selector });
    });
    this.app.post("/v1/sessions/:id/element", async (request, response) => {
      const input = InputSchemas.elementAction.parse(request.body);
      RemoteSessionPolicy.assertElement(
        input,
        Boolean(this.options.remote),
        this.remoteAuthentication.principal(request),
      );
      response.json(
        await this.sessions.run(request.params.id, (session) => session.elementAction(input), this.ownerId(request)),
      );
    });
    this.app.post("/v1/sessions/:id/upload", async (request, response) => {
      if (!request.is("application/octet-stream")) {
        response.status(415).json({ error: "Remote uploads require application/octet-stream." });
        return;
      }
      await this.sessions.run(
        request.params.id,
        (session) =>
          this.artifactHost.upload(session, request, request.header("x-browser-testbench-body-sha256") ?? ""),
        this.ownerId(request),
      );
      response.json({ uploaded: true });
    });
    this.app.post("/v1/sessions/:id/browser", async (request, response) => {
      const input = InputSchemas.browserAction.parse(request.body);
      const result = await this.sessions.run(
        request.params.id,
        (session) => session.browserAction(input),
        this.ownerId(request),
      );
      if (input.action === "waitDownload") {
        const artifact = await this.artifactHost.download(request.params.id, result);
        if (artifact) {
          await this.sendArtifact(response, artifact);
          return;
        }
      }
      response.json(result);
    });
    this.app.post("/v1/sessions/:id/screenshot", async (request, response) => {
      const { fullPage } = InputSchemas.screenshot.parse(request.body);
      response.json({
        base64: await this.sessions.run(
          request.params.id,
          (session) => session.captureScreenshot(fullPage),
          this.ownerId(request),
        ),
      });
    });
    this.app.post("/v1/sessions/:id/gesture", async (request, response) => {
      const input = InputSchemas.gesture.parse(request.body);
      response.json(
        await this.sessions.run(request.params.id, (session) => session.gesture(input), this.ownerId(request)),
      );
    });
    this.app.post("/v1/sessions/:id/wait", async (request, response) => {
      await this.sessions.run(
        request.params.id,
        (session) => session.wait(InputSchemas.wait.parse(request.body)),
        this.ownerId(request),
      );
      response.json({ ready: true });
    });
    this.app.get("/v1/sessions/:id/diagnostics", async (request, response) => {
      response.json(
        await this.sessions.run(request.params.id, (session) => session.diagnostics(), this.ownerId(request)),
      );
    });
    this.app.delete("/v1/sessions/:id/diagnostics", (request, response) => {
      this.sessions.get(request.params.id, this.ownerId(request)).clearDiagnostics();
      response.json({ cleared: true });
    });
    this.app.get("/v1/sessions/:id/devtools", (request, response) => {
      response.json(this.sessions.get(request.params.id, this.ownerId(request)).debugTools());
    });
    this.app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  }

  private notifyEnvironmentChanged(source: "android"): void {
    TargetCatalogService.invalidate();
    this.events.publish({ type: "environment.changed", source, occurredAt: new Date().toISOString() });
  }

  private notifyConnectionChanged(): void {
    this.events.publish({ type: "connection.changed", source: "remote", occurredAt: new Date().toISOString() });
  }

  private ownerId(request: Request): string {
    return this.remoteApi.ownerId(request);
  }

  private requireAdmin(request: Request, response: Response): boolean {
    return this.remoteApi.requireAdmin(request, response);
  }

  private authorize(request: Request, response: Response, next: NextFunction): void {
    if (!this.options.token) return next();
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expected = Buffer.from(this.options.token);
    const received = Buffer.from(supplied);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return next();
    response.status(401).json({ error: "Unauthorized" });
  }

  private refreshClientLease(clientId: string): void {
    clearTimeout(this.clientLeases.get(clientId));
    const lease = setTimeout(() => {
      this.clientLeases.delete(clientId);
      void this.closeOwnedAndCleanup(clientId).catch((error) =>
        console.error(`Remote client cleanup failed: ${error instanceof Error ? error.message : error}`),
      );
    }, TestbenchDefaults.REMOTE_LEASE_TIMEOUT_MS);
    lease.unref();
    this.clientLeases.set(clientId, lease);
  }

  private async closeOwnedAndCleanup(ownerId: string): Promise<void> {
    const sessionIds = this.sessions.list(ownerId).map((session) => session.id);
    let closeError: unknown;
    try {
      await this.sessions.closeOwned(ownerId);
    } catch (error) {
      closeError = error;
    }
    const cleanup = await Promise.allSettled(
      sessionIds.map((sessionId) => this.artifactHost.discardSession(sessionId)),
    );
    if (closeError) throw closeError;
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async sendArtifact(
    response: Response,
    artifact: { path: string; size: number; name: string },
  ): Promise<void> {
    response.status(200).set({
      "Content-Length": String(artifact.size),
      "Content-Type": "application/octet-stream",
      "X-Browser-Testbench-Artifact-Name": encodeURIComponent(artifact.name),
    });
    await pipeline(createReadStream(artifact.path), response);
  }
}
