import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES } from "../../src/config/types.js";
import {
  AuthorizedRemoteClientStore,
  RemoteCredentialStore,
  RemoteHostIdentityStore,
} from "../../src/remote/remote-client-store.js";
import { RemoteConnectionService } from "../../src/remote/remote-connection-service.js";
import { RemotePairingService } from "../../src/remote/remote-pairing-service.js";
import type { RemoteInstance } from "../../src/remote/remote-types.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { ApiServer } from "../../src/transports/api-server.js";
import { RemoteTestbench } from "../../src/transports/testbench-client.js";

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
        detail: "Remote integration test",
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

    const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
    const gateway = new ApiServer(
      { host: "127.0.0.1", port: 0 },
      { discovery: { discover: async () => [discovered] }, connections },
    );
    servers.push(gateway);
    const gatewayAddress = await gateway.start();
    const testbench = new RemoteTestbench({ server: `http://${gatewayAddress.host}:${gatewayAddress.port}` });

    expect(await testbench.discoverTestbenches()).toEqual([discovered]);
    const pairing = await testbench.connectTestbench(discovered);
    expect(pairing).toMatchObject({ pairingRequired: true });
    const code = announcements[0]!.match(/\d{6}$/)?.[0];
    const connected = await testbench.completePairing((pairing as { pairingId: string }).pairingId, code!);
    expect(connected).toMatchObject({ mode: "remote", remote: { instanceId: instance.instanceId, role: "control" } });
    expect((await testbench.targets()).map((target) => target.id)).toContain("edge");
    await expect(testbench.request("/v1/sessions/missing", { method: "DELETE" })).rejects.toThrow(
      "Session 'missing' was not found.",
    );
    expect(await testbench.disconnectTestbench()).toEqual({ mode: "local" });

    const reconnected = await testbench.connectTestbench(discovered);
    expect(reconnected).toMatchObject({
      mode: "remote",
      remote: { instanceId: instance.instanceId, role: "control" },
    });
    expect(announcements).toHaveLength(1);
  });
});
