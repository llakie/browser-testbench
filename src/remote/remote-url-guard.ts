import { networkInterfaces } from "node:os";
import { NetworkUrl } from "../infrastructure/network-url.js";

export class RemoteLoopbackUrlError extends Error {}

export class RemoteUrlGuard {
  static assertReachableFromRemote(value: unknown): void {
    if (typeof value !== "string") return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (!NetworkUrl.isLoopbackHostname(url.hostname)) return;
    const address = this.lanAddress();
    const suggestion = address ? NetworkUrl.withHostname(value, address) : "a LAN address";
    throw new RemoteLoopbackUrlError(
      `The remote browser cannot reach '${value}' because loopback points to the remote computer. Bind your application to a LAN interface and use an explicit address such as '${suggestion}'.`,
    );
  }

  static lanAddress(): string | undefined {
    for (const addresses of Object.values(networkInterfaces())) {
      const address = addresses?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
      if (address) return address.address;
    }
    return undefined;
  }
}
