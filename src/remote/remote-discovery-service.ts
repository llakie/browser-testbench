import { hostname } from "node:os";
import Bonjour, { type Browser, type Service } from "bonjour-service";
import { PackageMetadata } from "../config/package-metadata.js";
import { RemoteHostIdentityStore } from "./remote-client-store.js";
import type { RemoteInstance } from "./remote-types.js";

const SERVICE_TYPE = "btestbench";
const API_VERSION = 1;

export class RemoteDiscoveryPublisher {
  private bonjour?: Bonjour;

  constructor(private readonly identity = new RemoteHostIdentityStore()) {}

  async start(port: number): Promise<void> {
    if (this.bonjour) return;
    this.bonjour = new Bonjour(undefined, (error: Error) => console.error(`Remote discovery failed: ${error.message}`));
    this.bonjour.publish({
      name: hostname(),
      type: SERVICE_TYPE,
      port,
      txt: {
        instanceId: await this.identity.instanceId(),
        platform: process.platform,
        architecture: process.arch,
        version: PackageMetadata.VERSION,
        apiVersion: String(API_VERSION),
        authentication: "pairing",
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.bonjour) return;
    await new Promise<void>((resolve) => this.bonjour!.unpublishAll(() => resolve()));
    this.bonjour.destroy();
    this.bonjour = undefined;
  }
}

export class RemoteDiscoveryBrowser {
  async discover(timeoutMs = 1_500): Promise<RemoteInstance[]> {
    let discoveryError: Error | undefined;
    const bonjour = new Bonjour(undefined, (error: Error) => {
      discoveryError = error;
    });
    const found = new Map<string, RemoteInstance>();
    let browser: Browser | undefined;
    try {
      browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
        const instance = RemoteDiscoveryBrowser.toInstance(service);
        if (instance) found.set(instance.instanceId, instance);
      });
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      if (found.size === 0 && discoveryError)
        throw new Error(
          `mDNS discovery failed: ${discoveryError.message}. Check multicast UDP 5353, VPN settings, and the Windows private-network firewall rule for Node.js.`,
        );
      return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
    } finally {
      browser?.stop();
      bonjour.destroy();
    }
  }

  static toInstance(service: Service): RemoteInstance | undefined {
    const txt = service.txt as Record<string, string | undefined> | undefined;
    if (
      !txt?.instanceId ||
      !txt.platform ||
      !txt.architecture ||
      !txt.version ||
      !txt.apiVersion ||
      txt.authentication !== "pairing"
    )
      return undefined;
    const address = this.preferredAddress(service);
    if (!address) return undefined;
    return {
      instanceId: txt.instanceId,
      name: service.name,
      url: `http://${this.urlHost(address)}:${service.port}`,
      platform: txt.platform as NodeJS.Platform,
      architecture: txt.architecture,
      version: txt.version,
      apiVersion: Number(txt.apiVersion),
      authentication: "pairing",
    };
  }

  private static preferredAddress(service: Service): string | undefined {
    const addresses = [...(service.addresses ?? [])].sort();
    const source = service.referer?.address;
    return (
      (source && this.isUsableIPv4(source) ? source : undefined) ??
      (source && this.isUsableIPv6(source) ? source : undefined) ??
      addresses.find((address) => this.isUsableIPv4(address)) ??
      addresses.find((address) => address.includes(":") && !address.toLowerCase().startsWith("fe80:")) ??
      service.host ??
      addresses.find((address) => this.isIPv4(address) || address.includes(":"))
    );
  }

  private static isUsableIPv4(address: string): boolean {
    return this.isIPv4(address) && !address.startsWith("127.") && !address.startsWith("169.254.");
  }

  private static isUsableIPv6(address: string): boolean {
    return address.includes(":") && address !== "::1" && !address.toLowerCase().startsWith("fe80:");
  }

  private static isIPv4(address: string): boolean {
    return /^\d+\.\d+\.\d+\.\d+$/.test(address);
  }

  private static urlHost(address: string): string {
    return address.includes(":") ? `[${address.replace("%", "%25")}]` : address;
  }
}
