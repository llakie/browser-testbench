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
    expect((await targets.json()) as Array<{ id: string }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "chrome" })]),
    );
  });

  it("serves the environment UI and project-facing capabilities", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    const page = await fetch(`${baseUrl}/setup`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Browser und Geräte für deine Projekte");
    expect((await fetch(`${baseUrl}/ui-assets/setup.css`)).status).toBe(200);

    const initial = (await fetch(`${baseUrl}/v1/workbench`).then((response) => response.json())) as {
      platform: string;
      targets: Array<{ name: string }>;
      testTargets: Array<{ id: string }>;
      mcpClients: Array<{ id: string }>;
    };
    expect(initial.platform).toBe(process.platform);
    expect(initial.targets.map((target) => target.name)).toEqual([
      "chrome",
      "firefox",
      "safari",
      "edge",
      "safari-ios",
      "chrome-android",
    ]);
    expect(initial.testTargets.map((target) => target.id)).toContain("chrome");
    expect(initial.mcpClients.map((client) => client.id)).toEqual([
      "codex",
      "claude-code",
      "gemini-cli",
      "copilot-vscode",
      "other",
    ]);

    const capabilities = (await fetch(`${baseUrl}/v1/capabilities`).then((response) => response.json())) as {
      platform: string;
      targets: Array<{ name: string }>;
    };
    expect(capabilities.platform).toBe(process.platform);
    expect(capabilities.targets.map((target) => target.name)).toContain("chrome");
    expect((await fetch(`${baseUrl}/v1/workbench/config`, { method: "PUT" })).status).toBe(404);
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
    const response = await fetch(`http://${address.host}:${address.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid request" });

    const unknown = await fetch(`http://${address.host}:${address.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "netscape" }),
    });
    expect(unknown.status).toBe(404);

    const gesture = await fetch(`http://${address.host}:${address.port}/v1/sessions/missing/gesture`, {
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
