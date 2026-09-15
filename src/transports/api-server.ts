import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { ArtifactCatalog } from "../artifacts/artifact-catalog.js";
import { InteractiveController } from "../automation/interactive-controller.js";
import { ConfigFileStore } from "../config/config-file-store.js";
import { InputSchemas } from "../config/input-schemas.js";
import { TargetRegistry } from "../config/target-registry.js";
import type { TestbenchEvent } from "../config/types.js";
import { eventBus } from "../orchestration/event-bus.js";
import { runStore } from "../orchestration/run-store.js";
import { DoctorService } from "../setup/doctor-service.js";
import { SetupService } from "../setup/setup-service.js";
import { WorkbenchService } from "../setup/workbench-service.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { UiRenderer } from "../ui/ui-renderer.js";

export interface ApiServerOptions {
  host: string;
  port: number;
  token?: string;
  configPath?: string;
}

export class ApiServer {
  private readonly interactive = new InteractiveController();
  private readonly clients = new Set<Response>();
  private readonly app = express();
  private readonly server: Server;
  private readonly configs: ConfigFileStore;
  private readonly workbench: WorkbenchService;
  private unsubscribe?: () => void;

  constructor(private readonly options: ApiServerOptions) {
    this.configs = new ConfigFileStore(options.configPath ?? resolve(process.cwd(), "testbench.config.json"));
    this.workbench = new WorkbenchService(this.configs);
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
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    });
    this.server = createServer(this.app);
  }

  private registerPublicRoutes(): void {
    this.app.get("/", (_request, response) => response.redirect("/setup"));
    this.app.get("/setup", (_request, response) => response.type("html").send(UiRenderer.setup()));
    this.app.use("/ui-assets", express.static(join(TestbenchPaths.projectRoot, "public", "ui")));
    this.app.use(
      "/fontawesome",
      express.static(join(TestbenchPaths.projectRoot, "node_modules", "@fortawesome", "fontawesome-free")),
    );
  }

  async start(): Promise<{ host: string; port: number }> {
    this.unsubscribe = eventBus.subscribe((event) => this.broadcast(event));
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, resolve);
    });
    const address = this.server.address() as AddressInfo;
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const client of this.clients) client.end();
    await this.interactive.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private registerRoutes(): void {
    this.app.get("/health", (_request, response) => response.json({ status: "ok" }));
    this.app.get("/v1/targets", (_request, response) => response.json(TargetRegistry.definitions));
    this.app.get("/v1/doctor", async (_request, response) => response.json(await DoctorService.inspect()));
    this.app.get("/v1/workbench", async (_request, response) => response.json(await this.workbench.state()));
    this.app.put("/v1/workbench/config", async (request, response) => {
      response.json(await this.configs.save(request.body));
    });
    this.app.post("/v1/workbench/setup", async (request, response) => {
      const input = InputSchemas.setup.parse(request.body);
      response.json(await SetupService.install(input.targets, { androidAvdName: input.androidAvdName }));
    });
    this.app.post("/v1/workbench/run", async (_request, response) => {
      response.status(202).json(await runStore.start({ configPath: this.configs.path }));
    });
    this.app.get("/v1/runs", (_request, response) => response.json(runStore.list()));
    this.app.get("/v1/runs/:id", (request, response) => {
      const run = runStore.get(request.params.id);
      return run ? response.json(run) : response.status(404).json({ error: "Run not found" });
    });
    this.app.get("/v1/runs/:id/artifacts", async (request, response) => {
      response.json(await ArtifactCatalog.list(request.params.id));
    });
    this.app.get("/v1/runs/:id/artifact", async (request, response) => {
      const input = InputSchemas.artifact.parse({ runId: request.params.id, path: request.query.path });
      const artifact = await ArtifactCatalog.read(input.runId, input.path);
      response.type(artifact.mimeType).send(artifact.data);
    });
    this.app.post("/v1/runs", async (request, response) => {
      const body = InputSchemas.run.parse(request.body);
      response.status(202).json(await runStore.start(body));
    });
    this.app.get("/v1/events", (request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      this.clients.add(response);
      request.on("close", () => this.clients.delete(response));
    });
    this.app.post("/v1/session", async (request, response) => {
      response.status(201).json(await this.interactive.start(InputSchemas.startSession.parse(request.body)));
    });
    this.app.delete("/v1/session", async (_request, response) => {
      await this.interactive.close();
      response.json({ closed: true });
    });
    this.app.get("/v1/session/inspect", async (request, response) => {
      const { limit } = InputSchemas.inspect.parse(request.query);
      response.json(await this.interactive.inspect(limit));
    });
    this.app.post("/v1/session/navigate", async (request, response) => {
      const { url } = InputSchemas.navigate.parse(request.body);
      response.json(await this.interactive.navigate(url));
    });
    this.app.post("/v1/session/click", async (request, response) => {
      const { selector } = InputSchemas.click.parse(request.body);
      await this.interactive.click(selector);
      response.json({ clicked: selector });
    });
    this.app.post("/v1/session/type", async (request, response) => {
      const { selector, value, clear } = InputSchemas.type.parse(request.body);
      await this.interactive.type(selector, value, clear);
      response.json({ typed: selector });
    });
    this.app.post("/v1/session/screenshot", async (request, response) => {
      const { path } = InputSchemas.screenshot.parse(request.body);
      const screenshot = await this.interactive.screenshot(path);
      response.json(screenshot);
    });
    this.app.post("/v1/session/gesture", async (request, response) => {
      response.json(await this.interactive.gesture(InputSchemas.gesture.parse(request.body)));
    });
    this.app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  }

  private authorize(request: Request, response: Response, next: NextFunction): void {
    if (!this.options.token) return next();
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expected = Buffer.from(this.options.token);
    const received = Buffer.from(supplied);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return next();
    response.status(401).json({ error: "Unauthorized" });
  }

  private broadcast(event: TestbenchEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }
}
