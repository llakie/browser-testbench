import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TARGET_NAMES } from "../../src/config/types.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import {
  AuthorizedRemoteClientStore,
  RemoteCredentialStore,
  RemoteHostIdentityStore,
} from "../../src/remote/remote-client-store.js";
import { RemoteConnectionService } from "../../src/remote/remote-connection-service.js";
import { RemotePairingService } from "../../src/remote/remote-pairing-service.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { ApiServer } from "../../src/transports/api-server.js";

describe("remote CLI lifecycle", () => {
  it("pairs, connects, proxies commands, reports status, and disconnects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-remote-cli-"));
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
    const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
    const gateway = new ApiServer({ host: "127.0.0.1", port: 0 }, { connections });
    vi.spyOn(DoctorService, "inspect").mockResolvedValue(
      TARGET_NAMES.map((id) => ({
        id,
        label: id,
        status: id === "edge" ? "ready" : "skip",
        detail: "Remote CLI integration test",
      })),
    );

    try {
      const remoteAddress = await remote.start();
      const gatewayAddress = await gateway.start();
      const remoteUrl = `http://${remoteAddress.host}:${remoteAddress.port}`;
      const gatewayUrl = `http://${gatewayAddress.host}:${gatewayAddress.port}`;

      const pairingRequired = await runCli("connect", "--server", remoteUrl, "--gateway", gatewayUrl, "--json");
      expect(pairingRequired).toMatchObject({ code: 1 });
      expect(pairingRequired.stderr).toContain("Pairing is required");
      const code = announcements[0]!.match(/\d{6}$/)?.[0];
      expect(code).toMatch(/^\d{6}$/);

      const connected = await runCli(
        "connect",
        "--server",
        remoteUrl,
        "--gateway",
        gatewayUrl,
        "--code",
        code!,
        "--json",
      );
      expect(connected.code).toBe(0);
      expect(JSON.parse(connected.stdout)).toMatchObject({ mode: "remote", remote: { role: "control" } });

      const status = await runCli("status", "--server", gatewayUrl, "--json");
      expect(JSON.parse(status.stdout)).toMatchObject({ mode: "remote", reachable: true });
      const targets = await runCli("targets", "--server", gatewayUrl, "--json");
      expect(JSON.parse(targets.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "edge" })]));
      const doctor = await runCli("doctor", "--server", gatewayUrl, "--targets", "edge", "--json");
      expect(JSON.parse(doctor.stdout)).toEqual([
        expect.objectContaining({ id: "edge", detail: "edge is installed on the remote host." }),
      ]);
      const setup = await runCli("setup", "--server", gatewayUrl, "--targets", "edge", "--json");
      expect(JSON.parse(setup.stdout)).toEqual([]);

      const disconnected = await runCli("disconnect", "--server", gatewayUrl, "--json");
      expect(JSON.parse(disconnected.stdout)).toEqual({ mode: "local" });
    } finally {
      await gateway.stop();
      await remote.stop();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 30_000);
});

function runCli(...args: string[]) {
  return CommandRunner.run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
}
