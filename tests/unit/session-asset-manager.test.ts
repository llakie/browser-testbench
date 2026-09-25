import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionAssetManager } from "../../src/automation/session-asset-manager.js";
import { TestbenchDefaults } from "../../src/config/defaults.js";

describe("SessionAssetManager", () => {
  let root: string;
  let assets: SessionAssetManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "browser-testbench-assets-"));
    assets = new SessionAssetManager(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams a 20 MiB asset, verifies it and removes session files", async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 7);
    const reference = await assets.upload("owner", "session", Readable.from(bytes), {
      name: "card.jpg",
      contentType: "image/jpeg",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    expect(reference).toMatchObject({ name: "card.jpg", size: bytes.length, contentType: "image/jpeg" });
    expect(assets.resolve(reference, "owner", "session")).toContain(reference.id);

    await assets.cleanupSession("session");
    expect(await readdir(root)).toEqual([]);
    expect(() => assets.resolve(reference, "owner", "session")).toThrowError(
      expect.objectContaining({ code: "ASSET_NOT_FOUND" }),
    );
  });

  it("rejects traversal, checksum mismatches and oversized declarations", async () => {
    const bytes = Buffer.from("asset");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await expect(
      assets.upload("owner", "session", Readable.from(bytes), {
        name: "../secret",
        contentType: "text/plain",
        size: bytes.length,
        sha256,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_NAME" });
    await expect(
      assets.upload("owner", "session", Readable.from(bytes), {
        name: "asset.txt",
        contentType: "text/plain",
        size: bytes.length,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "ASSET_CHECKSUM_MISMATCH" });
    await expect(
      assets.upload("owner", "session", Readable.from([]), {
        name: "large.bin",
        contentType: "application/octet-stream",
        size: TestbenchDefaults.ASSET_LIMIT_BYTES + 1,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "ASSET_LIMIT_EXCEEDED",
      details: { limitBytes: TestbenchDefaults.ASSET_LIMIT_BYTES },
    });
  });
});
