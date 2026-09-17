import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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

export interface ApiServerOptions {
  host: string;
  port: number;
  token?: string;
  liveReload?: boolean;
}

export interface ApiServerDependencies {
  events?: WorkbenchEvents;
  androidMonitor?: AndroidDeviceMonitor;
}

export class ApiServer {
  private readonly sessions = new SessionManager();
  private readonly app = express();
  private readonly server: Server;
  private readonly workbench = new WorkbenchService();
  private readonly liveReload?: UiLiveReload;
  private readonly liveReloadResponses = new Set<Response>();
  private readonly events: WorkbenchEvents;
  private readonly eventStream: WorkbenchEventStream;
  private readonly androidMonitor: AndroidDeviceMonitor;

  constructor(
    private readonly options: ApiServerOptions,
    dependencies: ApiServerDependencies = {},
  ) {
    this.events = dependencies.events ?? new WorkbenchEvents();
    this.eventStream = new WorkbenchEventStream(this.events);
    this.androidMonitor =
      dependencies.androidMonitor ?? new AndroidDeviceMonitor(() => this.notifyEnvironmentChanged("android"));
    if (options.liveReload) {
      this.liveReload = new UiLiveReload([
        join(TestbenchPaths.projectRoot, "templates", "ui"),
        join(TestbenchPaths.projectRoot, "public", "ui"),
      ]);
    }
    this.app.disable("x-powered-by");
    this.registerPublicRoutes();
    this.app.use(express.json({ limit: "1mb" }));
    this.app.use((request, response, next) => this.authorize(request, response, next));
    this.registerRoutes();
    this.app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof ZodError) {
        response.status(400).json({ error: "Invalid request", issues: error.issues });
        return;
      }
      if (error instanceof SessionNotFoundError) {
        response.status(404).json({ error: error.message });
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
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    this.liveReload?.stop();
    this.androidMonitor.stop();
    for (const response of this.liveReloadResponses) response.end();
    this.liveReloadResponses.clear();
    this.eventStream.close();
    await this.sessions.closeAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
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
    this.app.get("/v1/targets", async (_request, response) => response.json(await TargetCatalogService.publicList()));
    this.app.get("/v1/doctor", async (_request, response) => response.json(await DoctorService.inspect()));
    this.app.get("/v1/capabilities", async (_request, response) => response.json(await this.workbench.capabilities()));
    this.app.post("/v1/verify", async (request, response) => {
      response.json(await TargetVerificationService.run(this.sessions, InputSchemas.verification.parse(request.body)));
    });
    this.app.get("/v1/workbench", async (_request, response) => response.json(await this.workbench.state()));
    this.app.post("/v1/workbench/setup", async (request, response) => {
      const input = InputSchemas.setup.parse(request.body);
      response.json(await SetupService.install(input.targets));
    });
    this.app.post("/v1/workbench/mcp", async (request, response) => {
      const input = InputSchemas.mcpIntegration.parse(request.body);
      response.json(await McpIntegrationService.register(input.client));
    });
    this.app.get("/v1/sessions", (_request, response) => response.json(this.sessions.list()));
    this.app.post("/v1/sessions", async (request, response) => {
      response.status(201).json(await this.sessions.start(InputSchemas.startSession.parse(request.body)));
    });
    this.app.delete("/v1/sessions/:id", async (request, response) => {
      const result = await this.sessions.close(request.params.id);
      response.json({ closed: true, ...result });
    });
    this.app.get("/v1/sessions/:id/inspect", async (request, response) => {
      const { limit } = InputSchemas.inspect.parse(request.query);
      response.json(await this.sessions.run(request.params.id, (session) => session.inspect(limit)));
    });
    this.app.get("/v1/sessions/:id/source", async (request, response) => {
      const { maxCharacters } = InputSchemas.pageSource.parse(request.query);
      response.json(await this.sessions.run(request.params.id, (session) => session.source(maxCharacters)));
    });
    this.app.post("/v1/sessions/:id/navigate", async (request, response) => {
      const { url } = InputSchemas.navigate.parse(request.body);
      response.json(await this.sessions.run(request.params.id, (session) => session.navigate(url)));
    });
    this.app.post("/v1/sessions/:id/click", async (request, response) => {
      const { selector } = InputSchemas.click.parse(request.body);
      await this.sessions.run(request.params.id, (session) => session.click(selector));
      response.json({ clicked: selector });
    });
    this.app.post("/v1/sessions/:id/type", async (request, response) => {
      const { selector, value, clear } = InputSchemas.type.parse(request.body);
      await this.sessions.run(request.params.id, (session) => session.type(selector, value, clear));
      response.json({ typed: selector });
    });
    this.app.post("/v1/sessions/:id/element", async (request, response) => {
      const input = InputSchemas.elementAction.parse(request.body);
      response.json(await this.sessions.run(request.params.id, (session) => session.elementAction(input)));
    });
    this.app.post("/v1/sessions/:id/browser", async (request, response) => {
      const input = InputSchemas.browserAction.parse(request.body);
      response.json(await this.sessions.run(request.params.id, (session) => session.browserAction(input)));
    });
    this.app.post("/v1/sessions/:id/screenshot", async (request, response) => {
      const { fullPage } = InputSchemas.screenshot.parse(request.body);
      response.json({
        base64: await this.sessions.run(request.params.id, (session) => session.captureScreenshot(fullPage)),
      });
    });
    this.app.post("/v1/sessions/:id/gesture", async (request, response) => {
      const input = InputSchemas.gesture.parse(request.body);
      response.json(await this.sessions.run(request.params.id, (session) => session.gesture(input)));
    });
    this.app.post("/v1/sessions/:id/wait", async (request, response) => {
      await this.sessions.run(request.params.id, (session) => session.wait(InputSchemas.wait.parse(request.body)));
      response.json({ ready: true });
    });
    this.app.get("/v1/sessions/:id/diagnostics", async (request, response) => {
      response.json(await this.sessions.run(request.params.id, (session) => session.diagnostics()));
    });
    this.app.delete("/v1/sessions/:id/diagnostics", (request, response) => {
      this.sessions.get(request.params.id).clearDiagnostics();
      response.json({ cleared: true });
    });
    this.app.get("/v1/sessions/:id/devtools", (request, response) => {
      response.json(this.sessions.get(request.params.id).debugTools());
    });
    this.app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  }

  private notifyEnvironmentChanged(source: "android"): void {
    TargetCatalogService.invalidate();
    this.events.publish({ type: "environment.changed", source, occurredAt: new Date().toISOString() });
  }

  private authorize(request: Request, response: Response, next: NextFunction): void {
    if (!this.options.token) return next();
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expected = Buffer.from(this.options.token);
    const received = Buffer.from(supplied);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return next();
    response.status(401).json({ error: "Unauthorized" });
  }
}
