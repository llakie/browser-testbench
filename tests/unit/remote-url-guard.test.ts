import { describe, expect, it } from "vitest";
import { RemoteUrlGuard } from "../../src/remote/remote-url-guard.js";

describe("RemoteUrlGuard", () => {
  it.each(["http://127.0.0.1:5173", "http://localhost:3000/path", "http://[::1]:8080"])(
    "rejects remote loopback URL %s with actionable guidance",
    (url) =>
      expect(() => RemoteUrlGuard.assertReachableFromRemote(url)).toThrow("Bind your application to a LAN interface"),
  );

  it("accepts an explicit LAN URL", () => {
    expect(() => RemoteUrlGuard.assertReachableFromRemote("http://192.168.1.20:5173")).not.toThrow();
  });
});
