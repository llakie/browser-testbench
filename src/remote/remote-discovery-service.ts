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
    const bonjour = new Bonjour();
    const found = new Map<string, RemoteInstance>();
    let browser: Browser | undefined;
    try {
      browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
        const instance = this.toInstance(service);
        if (instance) found.set(instance.instanceId, instance);
      });
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
    } finally {
      browser?.stop();
      bonjour.destroy();
    }
  }

  private toInstance(service: Service): RemoteInstance | undefined {
    const txt = service.txt as Record<string, string | undefined> | undefined;
    if (!txt?.instanceId || !txt.platform || !txt.architecture || !txt.version || !txt.apiVersion) return undefined;
    const address = service.addresses?.find((candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate)) ?? service.host;
    if (!address) return undefined;
    return {
      instanceId: txt.instanceId,
      name: service.name,
      url: `http://${address}:${service.port}`,
      platform: txt.platform as NodeJS.Platform,
      architecture: txt.architecture,
      version: txt.version,
      apiVersion: Number(txt.apiVersion),
    };
  }
}
