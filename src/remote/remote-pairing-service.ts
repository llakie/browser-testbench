import { randomUUID } from "node:crypto";
import { TestbenchDefaults } from "../config/defaults.js";
import { AuthorizedRemoteClientStore } from "./remote-client-store.js";
import { RemoteCrypto } from "./remote-crypto.js";
import type { EncryptedCredential, PairingChallenge, PairingCompletion, RemoteRole } from "./remote-types.js";

interface PendingPairing {
  pairingId: string;
  clientName: string;
  role: RemoteRole;
  serverPublicKey: string;
  clientId: string;
  key: Buffer;
  expiresAt: number;
  failedAttempts: number;
  sourceAddress?: string;
}

export class PairingNotFoundError extends Error {}
export class PairingRejectedError extends Error {}
export class PairingRateLimitError extends Error {}

export class RemotePairingService {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly clients: AuthorizedRemoteClientStore,
    private readonly announce: (message: string) => void = console.log,
  ) {}

  begin(
    clientName: string,
    role: RemoteRole,
    clientId: string,
    clientPublicKey: string,
    sourceAddress?: string,
  ): PairingChallenge {
    this.prune();
    const existing = [...this.pending.values()].find(
      (pairing) => pairing.clientId === clientId && pairing.clientName === clientName && pairing.role === role,
    );
    if (!existing && this.pending.size >= TestbenchDefaults.PAIRING_MAX_PENDING)
      throw new PairingRateLimitError("Too many pairing requests are pending. Wait for one to expire and try again.");
    if (
      !existing &&
      sourceAddress &&
      [...this.pending.values()].filter((pairing) => pairing.sourceAddress === sourceAddress).length >=
        TestbenchDefaults.PAIRING_MAX_PENDING_PER_ADDRESS
    )
      throw new PairingRateLimitError(
        "Too many pairing requests are pending from this address. Wait for one to expire and try again.",
      );
    const pairing = existing ?? this.create(clientName, role, clientId, clientPublicKey, sourceAddress);
    if (!existing) {
      this.pending.set(pairing.pairingId, pairing);
      this.announce(
        `${role === "admin" ? "Administrative" : "Remote"} pairing requested by ${clientName}. Pairing code: ${RemoteCrypto.pairingCode(pairing.key, pairing.pairingId)}`,
      );
    }
    return {
      pairingId: pairing.pairingId,
      serverPublicKey: pairing.serverPublicKey,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    };
  }

  list(): Array<{ pairingId: string; clientName: string; role: RemoteRole; code: string; expiresAt: string }> {
    this.prune();
    return [...this.pending.values()].map((pairing) => ({
      pairingId: pairing.pairingId,
      clientName: pairing.clientName,
      role: pairing.role,
      code: RemoteCrypto.pairingCode(pairing.key, pairing.pairingId),
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    }));
  }

  async complete(input: PairingCompletion): Promise<EncryptedCredential> {
    this.prune();
    const pairing = this.pending.get(input.pairingId);
    if (!pairing) throw new PairingNotFoundError("The pairing request expired or was not found.");
    if (pairing.clientId !== input.clientId || pairing.role !== input.role || pairing.clientName !== input.clientName) {
      throw new PairingRejectedError("The pairing request does not match this client.");
    }
    const expectedProof = RemoteCrypto.proof(pairing.key, input.clientId, input.role);
    if (!RemoteCrypto.equal(expectedProof, input.proof)) {
      pairing.failedAttempts += 1;
      if (pairing.failedAttempts >= 5) this.pending.delete(pairing.pairingId);
      throw new PairingRejectedError("The pairing proof is invalid.");
    }
    const client = await this.clients.authorize(input.clientName, input.role, input.clientId);
    this.pending.delete(input.pairingId);
    return RemoteCrypto.encrypt(pairing.key, client, pairing.pairingId);
  }

  private create(
    clientName: string,
    role: RemoteRole,
    clientId: string,
    clientPublicKey: string,
    sourceAddress?: string,
  ): PendingPairing {
    const keys = RemoteCrypto.ephemeralKeyPair();
    const pairingId = randomUUID();
    return {
      pairingId,
      clientName,
      role,
      serverPublicKey: keys.publicKey,
      clientId,
      key: RemoteCrypto.pairingKey(keys.ecdh, clientPublicKey, pairingId),
      expiresAt: Date.now() + TestbenchDefaults.PAIRING_TTL_MS,
      failedAttempts: 0,
      sourceAddress,
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, pairing] of this.pending) if (pairing.expiresAt <= now) this.pending.delete(id);
  }
}
