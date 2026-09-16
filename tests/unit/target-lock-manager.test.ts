import { describe, expect, it } from "vitest";
import { TargetLockManager } from "../../src/automation/target-lock-manager.js";

describe("TargetLockManager", () => {
  it("serializes the same target and allows different targets concurrently", async () => {
    const locks = new TargetLockManager();
    const releaseFirst = await locks.acquire("safari-ios-iphone-17-pro-26-5");
    let secondAcquired = false;
    const second = locks.acquire("safari-ios-iphone-17-pro-26-5").then((release) => {
      secondAcquired = true;
      return release;
    });

    const releaseOther = await locks.acquire("chrome-android-pixel-9-api-36");
    expect(secondAcquired).toBe(false);
    releaseOther();
    releaseFirst();

    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
    releaseSecond();
  });
});
