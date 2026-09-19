import { networkInterfaces } from "node:os";

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
    if (!this.isLoopback(url.hostname)) return;
    const address = this.lanAddress();
    const suggestion = address
      ? `${url.protocol}//${address}${url.port ? `:${url.port}` : ""}${url.pathname}`
      : "a LAN address";
    throw new RemoteLoopbackUrlError(
      `The remote browser cannot reach '${value}' because loopback points to the remote computer. Bind your application to a LAN interface and use an explicit address such as '${suggestion}'.`,
    );
  }

  private static isLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    return (
      normalized === "localhost" ||
      normalized === "::1" ||
      normalized === "[::1]" ||
      normalized === "0.0.0.0" ||
      normalized.startsWith("127.")
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
