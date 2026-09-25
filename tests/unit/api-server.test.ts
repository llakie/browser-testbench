import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES } from "../../src/config/types.js";
import { TestbenchDefaults } from "../../src/config/defaults.js";
import { SessionManager } from "../../src/automation/session-manager.js";
import { RemoteRequestAuthentication } from "../../src/remote/remote-request-authentication.js";
import { RemoteUrlGuard } from "../../src/remote/remote-url-guard.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { McpIntegrationService, type McpClientId } from "../../src/setup/mcp-integration-service.js";
import { SetupService } from "../../src/setup/setup-service.js";
import { ApiServer } from "../../src/transports/api-server.js";
import { ClientVersion } from "../../src/config/client-version.js";
import { UiRenderer } from "../../src/ui/ui-renderer.js";

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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serves health and target metadata on loopback", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const health = await fetch(`http://${address.host}:${address.port}/health`);
    const targets = await apiFetch(`http://${address.host}:${address.port}/v1/targets`);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await targets.json()) as Array<{ id: string }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "chrome" })]),
    );
  });

  it("rejects foreign host headers on a loopback Testbench", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();

    const response = await rawRequest(address.host, address.port, "attacker.example");

    expect(response.status).toBe(421);
    expect(JSON.parse(response.body)).toEqual({
      error: "The request host is not allowed for this loopback Testbench.",
    });
  });

  it("allows LAN host headers on an explicit wildcard binding", async () => {
    server = new ApiServer({ host: "0.0.0.0", port: 0, token: "test-secret" });
    const address = await server.start();

    const response = await rawRequest("127.0.0.1", address.port, "testbench.example", "test-secret");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("does not expose a remote identity unless remote mode is enabled", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();

    const response = await fetch(`http://${address.host}:${address.port}/v1/remote/identity`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Remote mode is not enabled." });
  });

  it("closes an already listening server when remote discovery startup fails", async () => {
    const publisher = {
      start: vi.fn().mockRejectedValue(new Error("mDNS unavailable")),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const failedServer = new ApiServer({ host: "127.0.0.1", port: 0, remote: true }, { publisher });

    await expect(failedServer.start()).rejects.toThrow("mDNS unavailable");
    expect(publisher.stop).toHaveBeenCalledOnce();
  });

  it("cleans up sessions when a remote client lease expires", async () => {
    vi.useFakeTimers();
    const sessions = new SessionManager();
    const closeOwned = vi.spyOn(sessions, "closeOwned").mockResolvedValue();
    let reportActivity: ((clientId: string) => void) | undefined;
    const authentication = {
      onActivity: (handler: (clientId: string) => void) => {
        reportActivity = handler;
      },
    } as unknown as RemoteRequestAuthentication;

    new ApiServer({ host: "127.0.0.1", port: 0, remote: true }, { sessions, remoteAuthentication: authentication });
    reportActivity!("remote-client");
    await vi.advanceTimersByTimeAsync(TestbenchDefaults.REMOTE_LEASE_TIMEOUT_MS);

    expect(closeOwned).toHaveBeenCalledWith("remote-client");
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
    expect(documentation).toContain('id="physical-ios"');
    expect(documentation).toContain('id="ios-signing"');
    expect(documentation).toContain('id="device-setup-checklist-template"');
    expect(documentation).toContain('id="physical-android"');
    expect(documentation).toContain("Window → Devices and Simulators");
    expect(documentation).toContain("Manage Certificates");
    expect(documentation).toContain("Product → Test");
    expect(documentation).toContain("AppleWWDRCAG3.cer");
    expect(documentation).toContain('href="/setup#environment-setup"');
    const localNetworkAddress = RemoteUrlGuard.lanAddress();
    if (localNetworkAddress) {
      expect(documentation).toContain(`http://${localNetworkAddress}:3000`);
      expect(documentation.replace(/\s+/g, " ")).toContain(
        `you must use http://${localNetworkAddress}:3000 instead of http://localhost:3000`,
      );
    } else expect(documentation).toContain("could not detect a LAN address");
    expect(documentation).not.toContain("YOUR-LAN-IP");
    expect(documentation).not.toContain("IP address of the Testbench that runs the tests");
    expect(documentation).toContain("browser-testbench start");
    expect(documentation).toContain("npm install --save-dev browser-testbench");
    expect(documentation).not.toContain("browser-testbench serve");
    expect(await fetch(`${baseUrl}/LICENSE.txt`).then((response) => response.text())).toContain("MIT License");
    expect(await fetch(`${baseUrl}/THIRD_PARTY_LICENSES.txt`).then((response) => response.text())).toContain(
      "express@5.2.1",
    );
    expect((await fetch(`${baseUrl}/licenses`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/ui-assets/setup.css`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/ui-assets/app.js`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/vendor/vue.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/ui-assets/setup.js`)).status).toBe(404);

    const germanSetup = await fetch(`${baseUrl}/setup`, { headers: { "accept-language": "de-DE,de;q=0.9" } }).then(
      (response) => response.text(),
    );
    expect(germanSetup).toContain('<html lang="de">');
    expect(germanSetup).toContain("Browser und Geräte für deine Projekte");
    const germanDocumentation = await fetch(`${baseUrl}/docs`, {
      headers: { "accept-language": "de-DE,de;q=0.9" },
    }).then((response) => response.text());
    expect(germanDocumentation).toContain("Physisches iPhone oder iPad verbinden");
    expect(germanDocumentation).toContain("Fenster → Geräte und Simulatoren (Window → Devices and Simulators)");
    expect(UiRenderer.documentation(false, true, "de-DE")).toContain(
      "Du musst die IP-Adresse der Testbench verwenden, die die Tests ausführt.",
    );

    const initial = (await apiFetch(`${baseUrl}/v1/workbench`).then((response) => response.json())) as {
      platform: string;
      targets: Array<{ name: string }>;
      testTargets: Array<{ id: string }>;
      mcpClients: Array<{ id: string }>;
      clientInstallCommand: string;
      packageName: string;
      localNetworkAddress?: string;
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
    expect(initial.localNetworkAddress).toBe(RemoteUrlGuard.lanAddress());

    const capabilities = (await apiFetch(`${baseUrl}/v1/capabilities`).then((response) => response.json())) as {
      platform: string;
      targets: Array<{ name: string }>;
    };
    expect(capabilities.platform).toBe(process.platform);
    expect(capabilities.targets.map((target) => target.name)).toContain("chrome");
    expect((await apiFetch(`${baseUrl}/v1/workbench/config`, { method: "PUT" })).status).toBe(404);
  });

  it("explains the executing Testbench address in remote mode", async () => {
    const publisher = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    server = new ApiServer({ host: "127.0.0.1", port: 0, remote: true }, { publisher });
    const address = await server.start();

    const documentation = await fetch(`http://${address.host}:${address.port}/docs`).then((response) =>
      response.text(),
    );
    const normalizedDocumentation = documentation.replace(/\s+/g, " ");

    expect(normalizedDocumentation).toContain("IP address of the Testbench that runs the tests");
    expect(normalizedDocumentation).toContain("Do not use the IP address of the local gateway");
    expect(documentation).not.toContain("YOUR-LAN-IP");
    expect(documentation).not.toContain(`http://${RemoteUrlGuard.lanAddress()}:3000`);
  });

  it("serves uncached UI pages with the reload client in development mode", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0, liveReload: true });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    const page = await fetch(`${baseUrl}/setup`);
    const asset = await fetch(`${baseUrl}/ui-assets/setup.css`);

    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain('data-live-reload="true"');
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

    const unauthorizedEvents = await apiFetch(`http://${address.host}:${address.port}/v1/events`);
    expect(unauthorizedEvents.status).toBe(401);
    const eventResponse = await apiFetch(`http://${address.host}:${address.port}/v1/events`, {
      headers: { authorization: "Bearer test-secret" },
    });
    const reader = eventResponse.body!.getReader();
    const firstEvent = await reader.read();
    expect(new TextDecoder().decode(firstEvent.value)).toContain("event: connected");
    await reader.cancel();
  });

  it("rejects invalid requests at the API boundary", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const response = await apiFetch(`http://${address.host}:${address.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid request" });

    const invalidVerification = await apiFetch(`http://${address.host}:${address.port}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "" }),
    });
    expect(invalidVerification.status).toBe(400);

    const unknown = await apiFetch(`http://${address.host}:${address.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "netscape" }),
    });
    expect(unknown.status).toBe(404);

    const gesture = await apiFetch(`http://${address.host}:${address.port}/v1/sessions/missing/gesture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "swipe", direction: "diagonal" }),
    });
    expect(gesture.status).toBe(400);
  });

  it("returns the underlying causes of aggregate runtime failures", async () => {
    vi.spyOn(SessionManager.prototype, "start").mockRejectedValue(
      new AggregateError(
        [new Error("The browser driver could not start."), new Error("The Appium process could not stop.")],
        "Session startup and cleanup failed.",
      ),
    );
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();

    const response = await apiFetch(`http://${address.host}:${address.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "chrome" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "Session startup and cleanup failed.\n- The browser driver could not start.\n- The Appium process could not stop.",
    });
  });

  it("returns structured guidance when a JSON payload exceeds the request limit", async () => {
    server = new ApiServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();

    const response = await apiFetch(`http://${address.host}:${address.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(TestbenchDefaults.REQUEST_BODY_LIMIT_BYTES) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      operation: "request.parse",
      details: {
        limitBytes: TestbenchDefaults.REQUEST_BODY_LIMIT_BYTES,
        suggestion: "session.assets.upload",
      },
    });
  });

  it("requires the exact client version for API requests but keeps diagnostics reachable", async () => {
    server = new ApiServer(
      { host: "127.0.0.1", port: 0, remote: true },
      {
        publisher: { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) },
      },
    );
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    const missing = await fetch(`${baseUrl}/v1/targets`);
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      code: "client_version_missing",
      expectedVersion: ClientVersion.CURRENT,
    });

    const mismatch = await fetch(`${baseUrl}/v1/targets`, {
      headers: { [ClientVersion.HEADER]: "999.0.0" },
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      code: "client_version_mismatch",
      expectedVersion: ClientVersion.CURRENT,
      actualVersion: "999.0.0",
    });

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/remote/identity`)).status).toBe(200);
  });
});

function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: ClientVersion.headers(init.headers) });
}

function rawRequest(
  hostname: string,
  port: number,
  host: string,
  token?: string,
): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const request = httpRequest({ hostname, port, path: "/health", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}
