import { describe, expect, it } from "vitest";
import { IosPhysicalUrlGuard } from "../../src/automation/ios-physical-url-guard.js";
import { RemoteUrlGuard } from "../../src/remote/remote-url-guard.js";

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

  it("rejects every local IPv4 alias and preserves the complete URL in its replacement", () => {
    const address = RemoteUrlGuard.lanAddress();
    const value = "http://127.0.0.2:3000/path?mode=test#result";

    expect(() => IosPhysicalUrlGuard.assertReachable(value, { name: "safari-ios", deviceKind: "physical" })).toThrow(
      address ? `http://${address}:3000/path?mode=test#result` : "cannot reach",
    );
    expect(() =>
      IosPhysicalUrlGuard.assertReachable("http://0.0.0.0:3000", {
        name: "safari-ios",
        deviceKind: "physical",
      }),
    ).toThrow("cannot reach");
  });
});
