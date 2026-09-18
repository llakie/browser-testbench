import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorizedRemoteClientStore } from "../../src/remote/remote-client-store.js";
import { RemoteCrypto } from "../../src/remote/remote-crypto.js";
import { PairingRejectedError, RemotePairingService } from "../../src/remote/remote-pairing-service.js";

describe("RemotePairingService", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("derives a credential from a one-time code without transmitting the code", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-pairing-"));
    const clientsPath = join(directory, "clients.json");
    const store = new AuthorizedRemoteClientStore(clientsPath);
    const announcements: string[] = [];
    const pairing = new RemotePairingService(store, (message) => announcements.push(message));
    const challenge = pairing.begin("developer-mac", "control");
    const code = announcements[0]!.match(/\d{6}$/)?.[0];
    const clientKeys = RemoteCrypto.ephemeralKeyPair();
    const key = RemoteCrypto.pairingKey(clientKeys.ecdh, challenge.serverPublicKey, code!, challenge.pairingId);

    const encrypted = await pairing.complete({
      pairingId: challenge.pairingId,
      clientId: "5b034f7b-511d-4fb4-a3cb-0d2333ab2651",
      clientName: "developer-mac",
      role: "control",
      clientPublicKey: clientKeys.publicKey,
      proof: RemoteCrypto.proof(key, "5b034f7b-511d-4fb4-a3cb-0d2333ab2651", "control"),
    });
    const credential = RemoteCrypto.decrypt<{ secret: string; role: string }>(key, encrypted, challenge.pairingId);

    expect(credential).toMatchObject({ role: "control", secret: expect.any(String) });
    expect(await store.list()).toHaveLength(1);
    expect(await readFile(clientsPath, "utf8")).not.toContain(code);
    await expect(
      pairing.complete({
        pairingId: challenge.pairingId,
        clientId: "5b034f7b-511d-4fb4-a3cb-0d2333ab2651",
        clientName: "developer-mac",
        role: "control",
        clientPublicKey: clientKeys.publicKey,
        proof: "replay",
      }),
    ).rejects.toThrow("expired or was not found");
  });

  it("rejects a proof derived from a wrong code", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-pairing-"));
    const pairing = new RemotePairingService(
      new AuthorizedRemoteClientStore(join(directory, "clients.json")),
      () => {},
    );
    const challenge = pairing.begin("developer-mac", "admin");
    const clientKeys = RemoteCrypto.ephemeralKeyPair();
    const wrongKey = RemoteCrypto.pairingKey(clientKeys.ecdh, challenge.serverPublicKey, "000000", challenge.pairingId);

    await expect(
      pairing.complete({
        pairingId: challenge.pairingId,
        clientId: "80f41ba1-207d-49dd-a9a6-ff20211bdf98",
        clientName: "developer-mac",
        role: "admin",
        clientPublicKey: clientKeys.publicKey,
        proof: RemoteCrypto.proof(wrongKey, "80f41ba1-207d-49dd-a9a6-ff20211bdf98", "admin"),
      }),
    ).rejects.toBeInstanceOf(PairingRejectedError);
  });
});
