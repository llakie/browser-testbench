import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventBus } from "../../src/orchestration/event-bus.js";
import { ApiServer } from "../../src/transports/api-server.js";

describe("ApiServer", () => {
  let server: ApiServer | undefined;
  afterEach(async () => server?.stop());

  it("serves health and target metadata on loopback", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const health = await fetch(`http://${address.host}:${address.port}/health`);
    const targets = await fetch(`http://${address.host}:${address.port}/v1/targets`);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await targets.json()) as object).toHaveProperty("safari-ios");
  });

  it("serves the Eta setup UI and hot-saves its fixed JSON config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-ui-"));
    const configPath = join(directory, "testbench.config.json");
    server = new ApiServer({ host: "127.0.0.1", port: 0, configPath });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    const page = await fetch(`${baseUrl}/setup`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Vom Projekt zum echten Browser-Test");
    expect((await fetch(`${baseUrl}/ui-assets/setup.css`)).status).toBe(200);

    const initial = (await fetch(`${baseUrl}/v1/workbench`).then((response) => response.json())) as {
      configExists: boolean;
      platform: string;
      targets: Array<{ name: string }>;
    };
    expect(initial.configExists).toBe(false);
    expect(initial.platform).toBe(process.platform);
    expect(initial.targets.every((target) => target.name !== "edge")).toBe(process.platform !== "win32");

    const config = {
      name: "ui-suite",
      baseUrl: "http://127.0.0.1:4173",
      targets: ["chrome"],
      specs: ["tests/browser/**/*.spec.mjs"],
    };
    const saved = await fetch(`${baseUrl}/v1/workbench/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
    const refreshed = (await fetch(`${baseUrl}/v1/workbench`).then((response) => response.json())) as {
      configExists: boolean;
      config: { name: string };
    };
    expect(refreshed).toMatchObject({ configExists: true, config: { name: "ui-suite" } });
  });

  it("enforces a bearer token when configured", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0, token: "test-secret" });
    const address = await server.start();
    const unauthorized = await fetch(`http://${address.host}:${address.port}/health`);
    const authorized = await fetch(`http://${address.host}:${address.port}/health`, {
      headers: { authorization: "Bearer test-secret" },
    });
    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  it("rejects invalid requests at the API boundary", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const response = await fetch(`http://${address.host}:${address.port}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "netscape" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid request" });

    const gesture = await fetch(`http://${address.host}:${address.port}/v1/session/gesture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "swipe", direction: "diagonal" }),
    });
    expect(gesture.status).toBe(400);
  });

  it("streams structured run events over SSE", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const response = await fetch(`http://${address.host}:${address.port}/v1/events`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    eventBus.publish({ type: "verification.event", data: { ok: true } });
    const event = await reader?.read();
    const text = new TextDecoder().decode(event?.value);
    expect(text).toContain("event: verification.event");
    expect(text).toContain('"ok":true');
    await reader?.cancel();
  });
});
