import { describe, expect, it } from "vitest";
import type { Service } from "bonjour-service";
import { RemoteDiscoveryBrowser } from "../../src/remote/remote-discovery-service.js";

describe("RemoteDiscoveryBrowser", () => {
  it("prefers a usable IPv4 address and exposes the authentication mode", () => {
    const instance = RemoteDiscoveryBrowser.toInstance(service(["fe80::1%en0", "192.168.1.30", "169.254.1.2"]));

    expect(instance).toMatchObject({
      url: "http://192.168.1.30:55808",
      authentication: "pairing",
    });
  });

  it("formats a global IPv6 fallback as a valid URL", () => {
    expect(RemoteDiscoveryBrowser.toInstance(service(["2001:db8::30"]))?.url).toBe("http://[2001:db8::30]:55808");
  });

  it("prefers the interface that delivered the mDNS response on multi-adapter hosts", () => {
    const advertised = service(["172.16.0.10", "192.168.1.30"]);
    advertised.referer = { address: "192.168.1.30", family: "IPv4", port: 5353, size: 1 };

    expect(RemoteDiscoveryBrowser.toInstance(advertised)?.url).toBe("http://192.168.1.30:55808");
  });
});

function service(addresses: string[]): Service {
  return {
    name: "Windows Testbench",
    host: "windows-testbench.local",
    port: 55_808,
    addresses,
    txt: {
      instanceId: "windows",
      platform: "win32",
      architecture: "x64",
      version: "0.1.8",
      apiVersion: "1",
      authentication: "pairing",
    },
  } as Service;
}
