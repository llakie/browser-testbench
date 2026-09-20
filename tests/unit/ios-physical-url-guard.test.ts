import { describe, expect, it } from "vitest";
import { IosPhysicalUrlGuard } from "../../src/automation/ios-physical-url-guard.js";

describe("IosPhysicalUrlGuard", () => {
  it("rejects loopback URLs only for physical iOS devices", () => {
    expect(() =>
      IosPhysicalUrlGuard.assertReachable("http://127.0.0.1:3000", {
        name: "safari-ios",
        deviceKind: "physical",
      }),
    ).toThrow("cannot reach");
    expect(() =>
      IosPhysicalUrlGuard.assertReachable("http://192.168.1.10:3000", {
        name: "safari-ios",
        deviceKind: "physical",
      }),
    ).not.toThrow();
    expect(() =>
      IosPhysicalUrlGuard.assertReachable("http://127.0.0.1:3000", {
        name: "safari-ios",
        deviceKind: "simulator",
      }),
    ).not.toThrow();
  });
});
