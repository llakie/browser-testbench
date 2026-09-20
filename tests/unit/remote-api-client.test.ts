import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteApiClient } from "../../src/remote/remote-api-client.js";
import { ClientVersion } from "../../src/config/client-version.js";

describe("RemoteApiClient", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts a remote request at its configured deadline", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new RemoteApiClient({
      instanceId: "remote",
      instanceName: "Windows Testbench",
      platform: "win32",
      architecture: "x64",
      version: "0.1.8",
      url: `http://127.0.0.1:${address.port}`,
      clientId: "client",
      clientName: "Mac",
      role: "control",
      secret: Buffer.alloc(32).toString("base64url"),
    });

    await expect(client.request("/health", { timeoutMs: 20 })).rejects.toThrow("timed out after 20 ms");
  });

  it("identifies signed remote requests with the exact package version", async () => {
    let receivedVersion: string | undefined;
    const server = createServer((request, response) => {
      const header = request.headers[ClientVersion.HEADER];
      receivedVersion = Array.isArray(header) ? header[0] : header;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new RemoteApiClient({
      instanceId: "remote",
      instanceName: "Windows Testbench",
      platform: "win32",
      architecture: "x64",
      version: ClientVersion.CURRENT,
      url: `http://127.0.0.1:${address.port}`,
      clientId: "client",
      clientName: "Mac",
      role: "control",
      secret: Buffer.alloc(32).toString("base64url"),
    });

    await client.request("/v1/targets");

    expect(receivedVersion).toBe(ClientVersion.CURRENT);
  });
});
