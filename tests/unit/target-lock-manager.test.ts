import { describe, expect, it } from "vitest";
import { TargetLockManager } from "../../src/automation/target-lock-manager.js";

describe("TargetLockManager", () => {
  it("serializes the same target and allows different targets concurrently", async () => {
    const locks = new TargetLockManager();
    const releaseFirst = await locks.acquire("safari-ios-iphone-17-pro-26-5", 1_000);
    let secondAcquired = false;
    const second = locks.acquire("safari-ios-iphone-17-pro-26-5", 1_000).then((release) => {
      secondAcquired = true;
      return release;
    });

    const releaseOther = await locks.acquire("chrome-android-pixel-9-api-36", 1_000);
    expect(secondAcquired).toBe(false);
    releaseOther();
    releaseFirst();

    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
    releaseSecond();
  });

  it("times out and cancels queued requests belonging to a disconnected client", async () => {
    const locks = new TargetLockManager();
    const release = await locks.acquire("device", 1_000, "first");
    const timedOut = locks.acquire("device", 0, "fail-fast");
    const disconnected = locks.acquire("device", 1_000, "second");

    await expect(timedOut).rejects.toThrow("busy");
    locks.cancelOwner("second");
    await expect(disconnected).rejects.toThrow("disconnected");
    release();
    expect(locks.isLocked("device")).toBe(false);
  });
});
