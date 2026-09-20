import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveController } from "../../src/automation/interactive-controller.js";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES } from "../../src/config/types.js";
import { ClientVersion } from "../../src/config/client-version.js";
import {
  AuthorizedRemoteClientStore,
  RemoteCredentialStore,
  RemoteHostIdentityStore,
} from "../../src/remote/remote-client-store.js";
import { RemoteConnectionService } from "../../src/remote/remote-connection-service.js";
import { RemoteApiClient } from "../../src/remote/remote-api-client.js";
import { RemotePairingService } from "../../src/remote/remote-pairing-service.js";
import type { RemoteInstance } from "../../src/remote/remote-types.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { TargetCatalogService } from "../../src/setup/target-catalog-service.js";
import { ApiServer } from "../../src/transports/api-server.js";
import { RemoteTestbench } from "../../src/transports/testbench-client.js";

const nonLoopbackAddress = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .find((address) => address.family === "IPv4" && !address.internal)?.address;

describe("remote gateway", () => {
  const servers: ApiServer[] = [];
  let directory: string | undefined;

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("discovers, pairs, proxies targets, disconnects, and reconnects without another code", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-remote-integration-"));
    vi.spyOn(DoctorService, "inspect").mockResolvedValue(
      TARGET_NAMES.map((id) => ({
        id,
        label: TargetRegistry.definitions[id].label,
        status: id === "edge" ? "ready" : "skip",
        detail:
          id === "edge" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : "Remote integration test",
      })),
    );
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
    servers.push(remote);
    const remoteAddress = await remote.start();
    const remoteUrl = `http://${remoteAddress.host}:${remoteAddress.port}`;
    const instance = (await fetch(`${remoteUrl}/v1/remote/identity`).then((response) => response.json())) as Omit<
      RemoteInstance,
      "url"
    >;
    const discovered: RemoteInstance = { ...instance, url: remoteUrl };
    expect(
      await fetch(`${remoteUrl}/v1/doctor`, { headers: ClientVersion.headers() }).then((response) => response.text()),
    ).toContain("C:\\\\Program Files");

    const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
    const gateway = new ApiServer(
      { host: "127.0.0.1", port: 0 },
      { discovery: { discover: async () => [discovered] }, connections },
    );
    servers.push(gateway);
    const gatewayAddress = await gateway.start();
    const testbench = new RemoteTestbench({ server: `http://${gatewayAddress.host}:${gatewayAddress.port}` });

    expect(await testbench.discoverTestbenches()).toEqual([discovered]);
    vi.spyOn(TargetCatalogService, "sessionOptions").mockResolvedValue({
      target: { id: "edge", serial: false },
      options: {},
    } as never);
    vi.spyOn(InteractiveController.prototype, "start").mockResolvedValue({});
    const closeLocalSession = vi.spyOn(InteractiveController.prototype, "close").mockResolvedValue({});
    await testbench.open({ target: "edge" });
    const pairing = await testbench.connectTestbench(discovered);
    expect(closeLocalSession).toHaveBeenCalledOnce();
    expect(pairing).toMatchObject({ pairingRequired: true });
    const code = announcements[0]!.match(/\d{6}$/)?.[0];
    const connected = await testbench.completePairing((pairing as { pairingId: string }).pairingId, code!);
    expect(connected).toMatchObject({ mode: "remote", remote: { instanceId: instance.instanceId, role: "control" } });
    expect((await testbench.targets()).map((target) => target.id)).toContain("edge");
    expect(JSON.stringify(await testbench.request("/v1/workbench"))).not.toContain("Program Files");
    expect(JSON.stringify(await testbench.request("/v1/doctor"))).not.toContain("Program Files");
    expect(JSON.stringify(await testbench.capabilities())).not.toContain("Program Files");
    expect(JSON.stringify(await testbench.targets())).not.toContain("Program Files");
    const mobileVerification = vi.spyOn(RemoteApiClient.prototype, "request").mockResolvedValue({
      target: "chrome-android-pixel-8-16",
      status: "passed",
      durationMs: 1,
      runtime: {},
    });
    await testbench.verify("chrome-android-pixel-8-16");
    expect(mobileVerification).toHaveBeenCalledWith("/v1/verify", expect.objectContaining({ timeoutMs: 7 * 60_000 }));
    mobileVerification.mockRestore();
    const signedRemote = connections.client()!;
    await expect(
      signedRemote.request("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ target: "edge", capabilities: { "ms:edgeOptions": { binary: "host.exe" } } }),
      }),
    ).rejects.toThrow("Administrative access is required");
    await expect(
      signedRemote.request("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ target: "edge", downloadDir: "C:\\host-downloads" }),
      }),
    ).rejects.toThrow("artifact transfer protocol");
    await expect(
      signedRemote.request("/v1/sessions/missing/element", {
        method: "POST",
        body: JSON.stringify({ action: "upload", selector: "input", paths: ["C:\\host\\secret.txt"] }),
      }),
    ).rejects.toThrow("artifact transfer protocol");
    await fetch(`http://127.0.0.1:${remoteAddress.port}/v1/remote/clients/${connected.remote!.clientId}`, {
      method: "PUT",
      headers: ClientVersion.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ role: "admin" }),
    });
    await vi.waitFor(() => expect(connections.status()).toMatchObject({ remote: { role: "admin" } }));
    await expect(
      signedRemote.request<Array<{ clientId: string; connected: boolean }>>("/v1/remote/clients"),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ clientId: connected.remote!.clientId, connected: true })]),
    );
    expect(JSON.stringify(await testbench.request("/v1/workbench"))).toContain("Program Files");
    await expect(testbench.request("/v1/sessions/missing", { method: "DELETE" })).rejects.toThrow(
      "Session 'missing' was not found.",
    );
    expect(await testbench.disconnectTestbench()).toEqual({ mode: "local" });

    const reconnected = await testbench.connectTestbench(discovered);
    expect(reconnected).toMatchObject({
      mode: "remote",
      remote: { instanceId: instance.instanceId, role: "admin" },
    });
    expect(announcements).toHaveLength(1);
  }, 60_000);

  it.runIf(nonLoopbackAddress)("authenticates a non-loopback control client and enforces revocation", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-remote-auth-integration-"));
    vi.spyOn(DoctorService, "inspect").mockResolvedValue([
      {
        id: "edge",
        label: TargetRegistry.definitions.edge.label,
        status: "ready",
        detail: "Remote integration test",
      },
    ]);
    const clients = new AuthorizedRemoteClientStore(join(directory, "clients.json"));
    const announcements: string[] = [];
    const remote = new ApiServer(
      { host: "0.0.0.0", port: 0, remote: true },
      {
        identity: new RemoteHostIdentityStore(join(directory, "identity.json")),
        clients,
        pairing: new RemotePairingService(clients, (message) => announcements.push(message)),
        publisher: { start: async () => {}, stop: async () => {} },
      },
    );
    servers.push(remote);
    const remoteAddress = await remote.start();
    const remoteUrl = `http://${nonLoopbackAddress}:${remoteAddress.port}`;
    const identity = (await fetch(`${remoteUrl}/v1/remote/identity`).then((response) => response.json())) as Omit<
      RemoteInstance,
      "url"
    >;
    const discovered = { ...identity, url: remoteUrl };
    const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
    const gateway = new ApiServer(
      { host: "127.0.0.1", port: 0 },
      { discovery: { discover: async () => [discovered] }, connections },
    );
    servers.push(gateway);
    const gatewayAddress = await gateway.start();
    const testbench = new RemoteTestbench({ server: `http://${gatewayAddress.host}:${gatewayAddress.port}` });

    const pairing = await testbench.connectTestbench(discovered);
    const code = announcements[0]!.match(/\d{6}$/)?.[0];
    const connected = await testbench.completePairing((pairing as { pairingId: string }).pairingId, code!);
    expect((await testbench.targets()).length).toBeGreaterThan(0);
    await expect(
      testbench.request("/v1/workbench/setup", {
        method: "POST",
        body: JSON.stringify({ targets: ["chrome"] }),
      }),
    ).rejects.toThrow("Administrative access is required");

    await fetch(`http://127.0.0.1:${remoteAddress.port}/v1/remote/clients/${connected.remote!.clientId}`, {
      method: "PUT",
      headers: ClientVersion.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ role: "admin" }),
    });
    await vi.waitFor(() => expect(connections.status()).toMatchObject({ remote: { role: "admin" }, reachable: true }));

    await fetch(`http://127.0.0.1:${remoteAddress.port}/v1/remote/clients/${connected.remote!.clientId}`, {
      method: "DELETE",
      headers: ClientVersion.headers(),
    });
    await vi.waitFor(async () => expect(await testbench.connection()).toEqual({ mode: "local" }));
    await expect(testbench.targets()).resolves.not.toHaveLength(0);
    await expect(testbench.connectTestbench(discovered)).resolves.toMatchObject({ pairingRequired: true });
  });
});
