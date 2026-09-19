import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { FixtureServer } from "../../src/support/fixture-server.js";
import { ApiServer } from "../../src/transports/api-server.js";
import {
  AuthorizedRemoteClientStore,
  RemoteCredentialStore,
  RemoteHostIdentityStore,
} from "../../src/remote/remote-client-store.js";
import { RemoteConnectionService } from "../../src/remote/remote-connection-service.js";
import { RemotePairingService } from "../../src/remote/remote-pairing-service.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;

describe("MCP browser control", () => {
  browserTest(
    "drives Chrome, inspects state, and captures a screenshot",
    async () => {
      const fixture = new FixtureServer();
      const url = await fixture.start();
      const api = new ApiServer({ host: "127.0.0.1", port: 0 });
      const address = await api.start();
      const outputDirectory = await mkdtemp(join(tmpdir(), "browser-testbench-mcp-"));
      const screenshotPath = join(outputDirectory, "mcp.png");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "mcp", "--server", `http://${address.host}:${address.port}`],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      const client = new Client({ name: "browser-testbench-integration", version: "1.0.0" });

      try {
        await client.connect(transport);
        await client.callTool({ name: "start_session", arguments: { target: "chrome", url, headless: true } });
        await client.callTool({
          name: "element_action",
          arguments: { action: "fill", selector: '[placeholder="Your name"]', value: "MCP" },
        });
        await client.callTool({ name: "element_action", arguments: { action: "check", selector: "#terms" } });
        await client.callTool({
          name: "wait_for_state",
          arguments: { selector: "#terms", state: "checked", timeoutMs: 5_000 },
        });
        await client.callTool({ name: "click", arguments: { selector: "#submit" } });
        await client.callTool({ name: "wait_for_text", arguments: { text: "Hello MCP", timeoutMs: 5_000 } });
        const inspection = await client.callTool({ name: "inspect_page", arguments: { limit: 20 } });
        expect(JSON.stringify(inspection.content)).toContain("Browser Testbench Fixture");
        const source = await client.callTool({ name: "get_page_source", arguments: { maxCharacters: 10_000 } });
        expect(JSON.stringify(source.content)).toContain("Hello MCP");
        const diagnostics = await client.callTool({ name: "get_diagnostics", arguments: {} });
        expect(JSON.stringify(diagnostics.content)).toContain("fixture submitted");
        const screenshot = await client.callTool({ name: "take_screenshot", arguments: { path: screenshotPath } });
        expect(screenshot.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: screenshotPath }),
            expect.objectContaining({ type: "image" }),
          ]),
        );
        await client.callTool({ name: "close_session", arguments: {} });
      } finally {
        await client.close();
        await api.stop();
        await fixture.stop();
      }
    },
    30_000,
  );

  browserTest(
    "clears the MCP session when disconnecting a remote Testbench",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "browser-testbench-mcp-remote-"));
      const clients = new AuthorizedRemoteClientStore(join(directory, "clients.json"));
      const announcements: string[] = [];
      const remote = new ApiServer(
        { host: "127.0.0.1", port: 0, remote: true },
        {
          identity: new RemoteHostIdentityStore(join(directory, "identity.json")),
          clients,
          pairing: new RemotePairingService(clients, (message) => announcements.push(message)),
          publisher: { start: async () => {}, stop: async () => {} },
        },
      );
      const remoteAddress = await remote.start();
      const remoteUrl = `http://${remoteAddress.host}:${remoteAddress.port}`;
      const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
      const gateway = new ApiServer({ host: "127.0.0.1", port: 0 }, { connections });
      const gatewayAddress = await gateway.start();
      const gatewayUrl = `http://${gatewayAddress.host}:${gatewayAddress.port}`;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "mcp", "--server", gatewayUrl],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      const client = new Client({ name: "browser-testbench-remote-lifecycle", version: "1.0.0" });

      try {
        await client.connect(transport);
        await client.callTool({ name: "start_session", arguments: { target: "chrome", headless: true } });
        const pairing = textPayload<{ pairingRequired: true; pairingId: string }>(
          await client.callTool({ name: "connect_testbench", arguments: { server: remoteUrl } }),
        );
        expect(pairing.pairingRequired).toBe(true);
        const code = announcements[0]!.match(/\d{6}$/)?.[0];
        const connected = textPayload<{ mode: string }>(
          await client.callTool({
            name: "connect_testbench",
            arguments: { pairingId: pairing.pairingId, code },
          }),
        );
        expect(connected.mode).toBe("remote");
        await client.callTool({ name: "start_session", arguments: { target: "chrome", headless: true } });
        await client.callTool({ name: "disconnect_testbench", arguments: {} });
        await expect(
          client.callTool({ name: "start_session", arguments: { target: "chrome", headless: true } }),
        ).resolves.toBeDefined();
        await client.callTool({ name: "close_session", arguments: {} });
      } finally {
        await client.close();
        await gateway.stop();
        await remote.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function textPayload<T>(result: unknown): T {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP result did not contain content.");
  }
  const content = result.content.find((item) => item.type === "text");
  if (!content?.text) throw new Error("MCP result did not contain text.");
  return JSON.parse(content.text) as T;
}
