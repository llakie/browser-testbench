import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistentTargetLock, TargetLockManager } from "../../src/automation/target-lock-manager.js";

describe("TargetLockManager", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "browser-testbench-locks-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes the same target and allows different targets concurrently", async () => {
    const locks = manager(root);
    const releaseFirst = await locks.acquire("safari-ios-iphone-17-pro-26-5", 1_000);
    let secondAcquired = false;
    const second = locks.acquire("safari-ios-iphone-17-pro-26-5", 1_000).then((release) => {
      secondAcquired = true;
      return release;
    });

    const releaseOther = await locks.acquire("chrome-android-pixel-9-api-36", 1_000);
    expect(secondAcquired).toBe(false);
    await releaseOther();
    await releaseFirst();

    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    await releaseSecond();
    await releaseSecond();
  });

  it("times out and cancels queued requests belonging to a disconnected client", async () => {
    const locks = manager(root);
    const release = await locks.acquire("device", 1_000, "first");
    const timedOut = locks.acquire("device", 0, "fail-fast");
    const disconnected = locks.acquire("device", 1_000, "second");

    await expect(timedOut).rejects.toThrow("busy");
    locks.cancelOwner("second");
    await expect(disconnected).rejects.toThrow("disconnected");
    await release();
    expect(locks.isLocked("device")).toBe(false);
  });

  it("keeps a live process lock across managers", async () => {
    const first = manager(root);
    const release = await first.acquire("device", 100, "owner-a", "session-a");
    const second = manager(root);

    await expect(second.acquire("device", 0, "owner-b", "session-b")).rejects.toMatchObject({
      code: "TARGET_BUSY",
      details: { target: "device", holder: { ownerId: "owner-a", sessionId: "session-a", pid: process.pid } },
    });

    await release();
  });

  it("removes a persisted lock whose process no longer exists", async () => {
    const first = manager(root);
    await first.acquire("device", 100, "owner-a", "session-a");
    const [directory] = await readdir(root);
    const metadataPath = join(root, directory!, "owner.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    await writeFile(metadataPath, `${JSON.stringify({ ...metadata, pid: 2_147_483_647 })}\n`);

    const second = manager(root);
    const release = await second.acquire("device", 100, "owner-b", "session-b");

    await expect(readFile(metadataPath, "utf8")).resolves.toContain('"sessionId":"session-b"');
    await release();
  });

  it("removes a persisted lock when the PID belongs to a different process start", async () => {
    const first = manager(root);
    await first.acquire("device", 100, "owner-a", "session-a");
    const [directory] = await readdir(root);
    const metadataPath = join(root, directory!, "owner.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    await writeFile(metadataPath, `${JSON.stringify({ ...metadata, processStartedAt: "2000-01-01T00:00:00.000Z" })}\n`);

    const second = manager(root);
    const release = await second.acquire("device", 100, "owner-b", "session-b");

    await expect(readFile(metadataPath, "utf8")).resolves.toContain('"sessionId":"session-b"');
    await release();
  });

  it("can retry a release after a persistent handoff failure", async () => {
    const persistent = new PersistentTargetLock(root);
    const handoff = vi.spyOn(persistent, "handoff").mockRejectedValueOnce(new Error("handoff failed"));
    const locks = new TargetLockManager(persistent);
    const releaseFirst = await locks.acquire("device", 100, "owner-a", "session-a");
    const second = locks.acquire("device", 1_000, "owner-b", "session-b");
    await new Promise((resolve) => setImmediate(resolve));

    await expect(releaseFirst()).rejects.toThrow("handoff failed");
    await expect(second).rejects.toThrow("handoff failed");
    await releaseFirst();

    expect(handoff).toHaveBeenCalledOnce();
    expect(locks.isLocked("device")).toBe(false);
  });
});

function manager(root: string): TargetLockManager {
  return new TargetLockManager(new PersistentTargetLock(root));
}
