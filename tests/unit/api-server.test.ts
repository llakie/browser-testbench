import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES } from "../../src/config/types.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { McpIntegrationService, type McpClientId } from "../../src/setup/mcp-integration-service.js";
import { SetupService } from "../../src/setup/setup-service.js";
import { ApiServer } from "../../src/transports/api-server.js";

describe("ApiServer", () => {
  let server: ApiServer | undefined;

  beforeEach(() => {
    vi.spyOn(DoctorService, "inspect").mockResolvedValue(
      TARGET_NAMES.map((id) => ({
        id,
        label: TargetRegistry.definitions[id].label,
        status: TargetRegistry.isSupported(id) ? "ready" : "skip",
        detail: "Test environment",
      })),
    );
    vi.spyOn(SetupService, "plan").mockResolvedValue([]);
    vi.spyOn(McpIntegrationService, "statuses").mockResolvedValue(
      (["codex", "claude-code", "gemini-cli", "copilot-vscode", "other"] as McpClientId[]).map((id) => ({
        id,
        label: id,
        installed: false,
        automatic: false,
        registered: false,
        current: false,
        command: "test command",
        format: "command",
        detail: "Test environment",
        instruction: "Test environment",
      })),
    );
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.restoreAllMocks();
  });

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
    expect(await page.text()).toContain("Browsers and devices for your projects");
    expect(await fetch(`${baseUrl}/targets`).then((response) => response.text())).toContain("Run all tests");
    const documentation = await fetch(`${baseUrl}/docs`).then((response) => response.text());
    expect(documentation).toContain("Documentation");
    expect(documentation).toContain("browser-testbench start");
    expect(documentation).toContain("npm install --save-dev browser-testbench");
    expect(documentation).not.toContain("browser-testbench serve");
    expect(await fetch(`${baseUrl}/LICENSE.txt`).then((response) => response.text())).toContain("MIT License");
    expect(await fetch(`${baseUrl}/THIRD_PARTY_LICENSES.txt`).then((response) => response.text())).toContain(
      "express@5.2.1",
    );
    expect((await fetch(`${baseUrl}/licenses`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/ui-assets/setup.css`)).status).toBe(200);

    const initial = (await fetch(`${baseUrl}/v1/workbench`).then((response) => response.json())) as {
      platform: string;
      targets: Array<{ name: string }>;
      testTargets: Array<{ id: string }>;
      mcpClients: Array<{ id: string }>;
      clientInstallCommand: string;
      packageName: string;
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
    expect(initial.clientInstallCommand).toBe("npm install --save-dev browser-testbench");
    expect(initial.packageName).toBe("browser-testbench");

    const capabilities = (await fetch(`${baseUrl}/v1/capabilities`).then((response) => response.json())) as {
      platform: string;
      targets: Array<{ name: string }>;
    };
    expect(capabilities.platform).toBe(process.platform);
    expect(capabilities.targets.map((target) => target.name)).toContain("chrome");
    expect((await fetch(`${baseUrl}/v1/workbench/config`, { method: "PUT" })).status).toBe(404);
  });

  it("serves uncached UI pages with the reload client in development mode", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0, liveReload: true });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    const page = await fetch(`${baseUrl}/setup`);
    const asset = await fetch(`${baseUrl}/ui-assets/setup.css`);

    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("/ui-assets/live-reload.js");
    expect(asset.headers.get("cache-control")).toBe("no-store");
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

    const invalidVerification = await fetch(`http://${address.host}:${address.port}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "" }),
    });
    expect(invalidVerification.status).toBe(400);

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
});
