import { randomInt, randomUUID } from "node:crypto";
import { TestbenchDefaults } from "../config/defaults.js";
import { AuthorizedRemoteClientStore } from "./remote-client-store.js";
import { RemoteCrypto, type EphemeralKeyPair } from "./remote-crypto.js";
import type { EncryptedCredential, PairingChallenge, PairingCompletion, RemoteRole } from "./remote-types.js";

interface PendingPairing {
  pairingId: string;
  code: string;
  clientName: string;
  role: RemoteRole;
  keys: EphemeralKeyPair;
  expiresAt: number;
  failedAttempts: number;
}

export class PairingNotFoundError extends Error {}
export class PairingRejectedError extends Error {}

export class RemotePairingService {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly clients: AuthorizedRemoteClientStore,
    private readonly announce: (message: string) => void = console.log,
  ) {}

  begin(clientName: string, role: RemoteRole): PairingChallenge {
    this.prune();
    const existing = [...this.pending.values()].find(
      (pairing) => pairing.clientName === clientName && pairing.role === role,
    );
    const pairing = existing ?? this.create(clientName, role);
    if (!existing) this.pending.set(pairing.pairingId, pairing);
    this.announce(
      `${role === "admin" ? "Administrative" : "Remote"} pairing requested by ${clientName}. Pairing code: ${pairing.code}`,
    );
    return {
      pairingId: pairing.pairingId,
      serverPublicKey: pairing.keys.publicKey,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    };
  }

  list(): Array<{ pairingId: string; clientName: string; role: RemoteRole; code: string; expiresAt: string }> {
    this.prune();
    return [...this.pending.values()].map((pairing) => ({
      pairingId: pairing.pairingId,
      clientName: pairing.clientName,
      role: pairing.role,
      code: pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    }));
  }

  async complete(input: PairingCompletion): Promise<EncryptedCredential> {
    this.prune();
    const pairing = this.pending.get(input.pairingId);
    if (!pairing) throw new PairingNotFoundError("The pairing request expired or was not found.");
    if (pairing.role !== input.role || pairing.clientName !== input.clientName) {
      throw new PairingRejectedError("The pairing request does not match this client.");
    }
    const key = RemoteCrypto.pairingKey(pairing.keys.ecdh, input.clientPublicKey, pairing.code, pairing.pairingId);
    const expectedProof = RemoteCrypto.proof(key, input.clientId, input.role);
    if (!RemoteCrypto.equal(expectedProof, input.proof)) {
      pairing.failedAttempts += 1;
      if (pairing.failedAttempts >= 5) this.pending.delete(pairing.pairingId);
      throw new PairingRejectedError("The pairing code is invalid.");
    }
    const client = await this.clients.authorize(input.clientName, input.role, input.clientId);
    this.pending.delete(input.pairingId);
    return RemoteCrypto.encrypt(key, client, pairing.pairingId);
  }

  private create(clientName: string, role: RemoteRole): PendingPairing {
    return {
      pairingId: randomUUID(),
      code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
      clientName,
      role,
      keys: RemoteCrypto.ephemeralKeyPair(),
      expiresAt: Date.now() + TestbenchDefaults.PAIRING_TTL_MS,
      failedAttempts: 0,
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, pairing] of this.pending) if (pairing.expiresAt <= now) this.pending.delete(id);
  }
}
