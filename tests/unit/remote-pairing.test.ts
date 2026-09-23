import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestbenchDefaults } from "../../src/config/defaults.js";
import { AuthorizedRemoteClientStore } from "../../src/remote/remote-client-store.js";
import { RemoteCrypto } from "../../src/remote/remote-crypto.js";
import {
  PairingRateLimitError,
  PairingRejectedError,
  RemotePairingService,
} from "../../src/remote/remote-pairing-service.js";

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
    const clientKeys = RemoteCrypto.ephemeralKeyPair();
    const clientId = "5b034f7b-511d-4fb4-a3cb-0d2333ab2651";
    const challenge = pairing.begin("developer-mac", "control", clientId, clientKeys.publicKey);
    const key = RemoteCrypto.pairingKey(clientKeys.ecdh, challenge.serverPublicKey, challenge.pairingId);
    const code = announcements[0]!.match(/\d{6}$/)?.[0];

    expect(RemoteCrypto.pairingCode(key, challenge.pairingId)).toBe(code);

    const encrypted = await pairing.complete({
      pairingId: challenge.pairingId,
      clientId,
      clientName: "developer-mac",
      role: "control",
      proof: RemoteCrypto.proof(key, clientId, "control"),
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
        proof: "replay",
      }),
    ).rejects.toThrow("expired or was not found");
  });

  it("rejects an invalid client proof", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-pairing-"));
    const pairing = new RemotePairingService(
      new AuthorizedRemoteClientStore(join(directory, "clients.json")),
      () => {},
    );
    const clientKeys = RemoteCrypto.ephemeralKeyPair();
    const challenge = pairing.begin(
      "developer-mac",
      "admin",
      "80f41ba1-207d-49dd-a9a6-ff20211bdf98",
      clientKeys.publicKey,
    );

    await expect(
      pairing.complete({
        pairingId: challenge.pairingId,
        clientId: "80f41ba1-207d-49dd-a9a6-ff20211bdf98",
        clientName: "developer-mac",
        role: "admin",
        proof: "invalid",
      }),
    ).rejects.toBeInstanceOf(PairingRejectedError);
  });

  it("detects an active server-key substitution through the displayed code", () => {
    const pairingId = "35c290e6-b56e-446b-a379-d35080cf40e8";
    const hostKey = Buffer.alloc(32, 1);
    const interceptedKey = Buffer.alloc(32, 2);

    expect(RemoteCrypto.pairingCode(interceptedKey, pairingId)).not.toBe(RemoteCrypto.pairingCode(hostKey, pairingId));
  });

  it("deduplicates retries and limits pending pairing requests", () => {
    const announcements: string[] = [];
    const pairing = new RemotePairingService(
      new AuthorizedRemoteClientStore(join(tmpdir(), `unused-${Date.now()}.json`)),
      (message) => announcements.push(message),
    );
    const repeatedKeys = RemoteCrypto.ephemeralKeyPair();
    const repeated = pairing.begin(
      "developer-mac",
      "control",
      "5b034f7b-511d-4fb4-a3cb-0d2333ab2651",
      repeatedKeys.publicKey,
    );
    expect(
      pairing.begin("developer-mac", "control", "5b034f7b-511d-4fb4-a3cb-0d2333ab2651", repeatedKeys.publicKey),
    ).toEqual(repeated);

    for (let index = 1; index < TestbenchDefaults.PAIRING_MAX_PENDING; index += 1) {
      const keys = RemoteCrypto.ephemeralKeyPair();
      pairing.begin(
        `client-${index}`,
        "control",
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        keys.publicKey,
      );
    }
    const rejectedKeys = RemoteCrypto.ephemeralKeyPair();
    expect(() =>
      pairing.begin("one-too-many", "control", "00000000-0000-4000-8000-999999999999", rejectedKeys.publicKey),
    ).toThrow(PairingRateLimitError);
    expect(announcements).toHaveLength(TestbenchDefaults.PAIRING_MAX_PENDING);
  });

  it("limits pending pairing requests from one network address", () => {
    const pairing = new RemotePairingService(
      new AuthorizedRemoteClientStore(join(tmpdir(), `unused-${Date.now()}.json`)),
      () => {},
    );
    for (let index = 0; index < TestbenchDefaults.PAIRING_MAX_PENDING_PER_ADDRESS; index += 1) {
      const keys = RemoteCrypto.ephemeralKeyPair();
      pairing.begin(
        `client-${index}`,
        "control",
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        keys.publicKey,
        "192.0.2.1",
      );
    }
    const rejectedKeys = RemoteCrypto.ephemeralKeyPair();

    expect(() =>
      pairing.begin(
        "one-too-many",
        "control",
        "00000000-0000-4000-8000-999999999999",
        rejectedKeys.publicKey,
        "192.0.2.1",
      ),
    ).toThrow(PairingRateLimitError);
    expect(() =>
      pairing.begin(
        "different-address",
        "control",
        "00000000-0000-4000-8000-888888888888",
        rejectedKeys.publicKey,
        "192.0.2.2",
      ),
    ).not.toThrow();
  });
});
