import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type ECDH,
} from "node:crypto";
import type { EncryptedCredential } from "./remote-types.js";

export interface EphemeralKeyPair {
  ecdh: ECDH;
  publicKey: string;
}

export class RemoteCrypto {
  static ephemeralKeyPair(): EphemeralKeyPair {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return { ecdh, publicKey: ecdh.getPublicKey().toString("base64url") };
  }

  static pairingKey(ecdh: ECDH, remotePublicKey: string, pairingId: string): Buffer {
    const sharedSecret = ecdh.computeSecret(Buffer.from(remotePublicKey, "base64url"));
    return Buffer.from(
      hkdfSync("sha256", sharedSecret, Buffer.from(pairingId), Buffer.from("browser-testbench:pairing"), 32),
    );
  }

  static pairingCode(key: Buffer, pairingId: string): string {
    const value = createHmac("sha256", key).update(`pairing-code:${pairingId}`).digest().readUInt32BE();
    return (value % 1_000_000).toString().padStart(6, "0");
  }

  static proof(key: Buffer, clientId: string, role: string): string {
    return createHmac("sha256", key).update(`client-proof:${clientId}:${role}`).digest("base64url");
  }

  static equal(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  static encrypt(key: Buffer, value: unknown, pairingId: string): EncryptedCredential {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(pairingId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authenticationTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  static decrypt<T>(key: Buffer, encrypted: EncryptedCredential, pairingId: string): T {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64url"));
    decipher.setAAD(Buffer.from(pairingId));
    decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64url"));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64url")), decipher.final()]).toString(
        "utf8",
      ),
    ) as T;
  }

  static bodyHash(body: string): string {
    return createHash("sha256").update(body).digest("base64url");
  }

  static requestSignature(
    secret: string,
    method: string,
    path: string,
    timestamp: string,
    nonce: string,
    body: string,
    bodyHash = this.bodyHash(body),
  ): string {
    const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
    return createHmac("sha256", Buffer.from(secret, "base64url")).update(canonical).digest("base64url");
  }
}
