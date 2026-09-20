import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackageMetadata } from "../../src/config/package-metadata.js";
import { RemoteCredentialStore } from "../../src/remote/remote-client-store.js";
import { RemoteConnectionService } from "../../src/remote/remote-connection-service.js";
import { RemoteCrypto } from "../../src/remote/remote-crypto.js";
import type { RemoteClientCredential, RemoteInstance } from "../../src/remote/remote-types.js";

describe("RemoteConnectionService", () => {
  let directory: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("requires an explicit disconnect before activating another remote", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-connections-"));
    const store = new RemoteCredentialStore(join(directory, "credentials.json"));
    const credential: RemoteClientCredential = {
      instanceId: "windows",
      instanceName: "Windows Testbench",
      platform: "win32",
      architecture: "x64",
      version: PackageMetadata.VERSION,
      url: "http://windows.test",
      clientId: "client",
      clientName: "Mac",
      role: "control",
      secret: Buffer.alloc(32).toString("base64url"),
    };
    await store.save(credential);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ clientId: credential.clientId, role: credential.role }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const connections = new RemoteConnectionService(store);
    const windows = instance("windows", "Windows Testbench");

    await expect(connections.connect(windows)).resolves.toMatchObject({ mode: "remote" });
    await expect(connections.connect(windows)).resolves.toMatchObject({ mode: "remote" });
    const callsBeforeRejectedConnect = fetchMock.mock.calls.length;
    await expect(connections.connect(instance("linux", "Linux Testbench"))).rejects.toThrow(
      "Disconnect from 'Windows Testbench'",
    );
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRejectedConnect);
    await connections.disconnect();
  });

  it("rejects an incompatible product version before making a network request", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-connections-"));
    const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
    const incompatibleVersion = incompatibleProductVersion();
    const incompatible = { ...instance("windows", "Windows Testbench"), version: incompatibleVersion };
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(connections.connect(incompatible)).rejects.toThrow(
      `incompatible product version ${incompatibleVersion}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a local pairing after five incorrect codes", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-connections-"));
    const serverKeys = RemoteCrypto.ephemeralKeyPair();
    const pairingId = "35c290e6-b56e-446b-a379-d35080cf40e8";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          pairingId,
          serverPublicKey: serverKeys.publicKey,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
    const pending = await connections.connect(instance("windows", "Windows Testbench"));
    expect(pending).toMatchObject({ pairingRequired: true, pairingId });

    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(connections.completePairing(pairingId, "not-a-code")).rejects.toThrow("does not match");
    await expect(connections.completePairing(pairingId, "not-a-code")).rejects.toThrow("expired or was not found");
  });
});

function instance(instanceId: string, name: string): RemoteInstance {
  return {
    instanceId,
    name,
    url: `http://${instanceId}.test`,
    platform: "win32",
    architecture: "x64",
    version: PackageMetadata.VERSION,
    apiVersion: 1,
    authentication: "pairing",
  };
}

function incompatibleProductVersion(): string {
  const [major = 0, minor = 0, patch = 0] = PackageMetadata.VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
