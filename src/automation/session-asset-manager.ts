import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TestbenchDefaults } from "../config/defaults.js";
import { TestbenchError } from "../errors/testbench-error.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

export interface AssetReference {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
}

interface StoredAsset extends AssetReference {
  ownerId: string;
  sessionId?: string;
  path: string;
}

export interface AssetUploadMetadata {
  name: string;
  contentType: string;
  size: number;
  sha256: string;
}

export class SessionAssetManager {
  private readonly assets = new Map<string, StoredAsset>();

  constructor(private readonly root = TestbenchPaths.data("assets", String(process.pid))) {}

  async upload(
    ownerId: string,
    sessionId: string | undefined,
    source: Readable,
    metadata: AssetUploadMetadata,
    signal?: AbortSignal,
  ): Promise<AssetReference> {
    const name = this.safeName(metadata.name);
    this.validateMetadata(metadata);
    const currentBytes = [...this.assets.values()]
      .filter((asset) => asset.ownerId === ownerId && asset.sessionId === sessionId)
      .reduce((total, asset) => total + asset.size, 0);
    if (currentBytes + metadata.size > TestbenchDefaults.SESSION_ASSET_TOTAL_LIMIT_BYTES)
      throw this.limitError(
        "Session asset total",
        currentBytes + metadata.size,
        TestbenchDefaults.SESSION_ASSET_TOTAL_LIMIT_BYTES,
      );

    const id = randomUUID();
    const directory = join(this.root, this.scopeDirectory(ownerId, sessionId));
    const path = join(directory, id);
    await mkdir(directory, { recursive: true });
    const hash = createHash("sha256");
    let actualBytes = 0;
    const verifier = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        actualBytes += chunk.length;
        if (actualBytes > TestbenchDefaults.ASSET_LIMIT_BYTES) {
          callback(this.limitError("Asset", actualBytes, TestbenchDefaults.ASSET_LIMIT_BYTES));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, verifier, createWriteStream(path, { flags: "wx" }), { signal });
      const actualSha256 = hash.digest("hex");
      if (actualBytes !== metadata.size || actualSha256 !== metadata.sha256) {
        throw new TestbenchError("ASSET_CHECKSUM_MISMATCH", "Asset size or SHA-256 does not match its declaration.", {
          operation: "asset.upload",
          status: 400,
          details: {
            declaredBytes: metadata.size,
            actualBytes,
            declaredSha256: metadata.sha256,
            actualSha256,
          },
        });
      }
      const asset = { id, name, contentType: metadata.contentType, size: actualBytes, sha256: actualSha256 };
      this.assets.set(id, { ...asset, ownerId, sessionId, path });
      return asset;
    } catch (error) {
      await rm(path, { force: true });
      if (signal?.aborted)
        throw new TestbenchError("OPERATION_ABORTED", "Asset upload was aborted.", {
          operation: "asset.upload",
          status: 499,
        });
      throw error;
    }
  }

  resolve(reference: AssetReference, ownerId: string, sessionId?: string): string {
    const asset = this.assets.get(reference.id);
    if (!asset || asset.ownerId !== ownerId || (asset.sessionId && asset.sessionId !== sessionId)) {
      throw new TestbenchError("ASSET_NOT_FOUND", "Asset reference is not available in this session.", {
        operation: "asset.resolve",
        status: 404,
        details: { assetId: reference.id },
      });
    }
    return asset.path;
  }

  resource(
    reference: AssetReference,
    ownerId: string,
    sessionId?: string,
  ): { reference: AssetReference; path: string } {
    const path = this.resolve(reference, ownerId, sessionId);
    const asset = this.assets.get(reference.id)!;
    return {
      path,
      reference: {
        id: asset.id,
        name: asset.name,
        contentType: asset.contentType,
        size: asset.size,
        sha256: asset.sha256,
      },
    };
  }

  bind(reference: AssetReference, ownerId: string, sessionId: string): void {
    const asset = this.assets.get(reference.id);
    if (!asset || asset.ownerId !== ownerId || asset.sessionId) {
      throw new TestbenchError("ASSET_NOT_FOUND", "Asset reference cannot be bound to this session.", {
        operation: "asset.bind",
        status: 404,
        details: { assetId: reference.id },
      });
    }
    asset.sessionId = sessionId;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const matching = [...this.assets.values()].filter((asset) => asset.sessionId === sessionId);
    for (const asset of matching) this.assets.delete(asset.id);
    await Promise.all(matching.map((asset) => rm(asset.path, { force: true })));
    await Promise.all(
      [...new Set(matching.map((asset) => dirname(asset.path)))].map((path) => rmdir(path).catch(() => undefined)),
    );
  }

  async cleanup(): Promise<void> {
    this.assets.clear();
    await rm(this.root, { recursive: true, force: true });
  }

  private safeName(value: string): string {
    if (!value || isAbsolute(value) || basename(value.replaceAll("\\", "/")) !== value) {
      throw new TestbenchError("INVALID_ASSET_NAME", "Asset name must be a filename without directories.", {
        operation: "asset.upload",
        status: 400,
        details: { name: value },
      });
    }
    return value;
  }

  private scopeDirectory(ownerId: string, sessionId?: string): string {
    const scope = sessionId ? `session:${sessionId}` : `staged:${ownerId}`;
    return createHash("sha256").update(scope).digest("hex");
  }

  private validateMetadata(metadata: AssetUploadMetadata): void {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new TestbenchError("INVALID_ASSET_SIZE", "Asset size must be a non-negative safe integer.", {
        operation: "asset.upload",
        status: 400,
        details: { size: metadata.size },
      });
    }
    if (metadata.size > TestbenchDefaults.ASSET_LIMIT_BYTES)
      throw this.limitError("Asset", metadata.size, TestbenchDefaults.ASSET_LIMIT_BYTES);
    if (!/^[a-f0-9]{64}$/u.test(metadata.sha256)) {
      throw new TestbenchError(
        "INVALID_ASSET_CHECKSUM",
        "Asset SHA-256 must contain 64 lowercase hexadecimal characters.",
        {
          operation: "asset.upload",
          status: 400,
        },
      );
    }
  }

  private limitError(label: string, actualBytes: number, limitBytes: number): TestbenchError {
    return new TestbenchError("ASSET_LIMIT_EXCEEDED", `${label} exceeds the ${limitBytes}-byte limit.`, {
      operation: "asset.upload",
      status: 413,
      details: { actualBytes, limitBytes },
    });
  }
}
