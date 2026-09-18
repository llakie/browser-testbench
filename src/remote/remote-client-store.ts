import { hostname } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { JsonFileStore } from "./json-file-store.js";
import type { AuthorizedRemoteClient, RemoteClientCredential, RemoteRole } from "./remote-types.js";

interface HostIdentityData {
  instanceId: string;
}

interface AuthorizedClientsData {
  clients: AuthorizedRemoteClient[];
}

interface RemoteCredentialsData {
  remotes: RemoteClientCredential[];
}

export class RemoteHostIdentityStore {
  private readonly store: JsonFileStore<HostIdentityData>;

  constructor(path = TestbenchPaths.data("remote", "identity.json")) {
    this.store = new JsonFileStore(path, () => ({ instanceId: randomUUID() }));
  }

  async instanceId(): Promise<string> {
    const identity = await this.store.read();
    await this.store.write(identity);
    return identity.instanceId;
  }
}

export class AuthorizedRemoteClientStore {
  private readonly store: JsonFileStore<AuthorizedClientsData>;

  constructor(path = TestbenchPaths.data("remote", "clients.json")) {
    this.store = new JsonFileStore(path, () => ({ clients: [] }));
  }

  async authorize(name: string, role: RemoteRole, clientId: string = randomUUID()): Promise<AuthorizedRemoteClient> {
    const now = new Date().toISOString();
    const client: AuthorizedRemoteClient = {
      clientId,
      name,
      role,
      secret: randomBytes(32).toString("base64url"),
      createdAt: now,
      lastUsedAt: now,
    };
    await this.store.update((data) => ({
      clients: [...data.clients.filter((candidate) => candidate.clientId !== clientId), client],
    }));
    return client;
  }

  async find(clientId: string): Promise<AuthorizedRemoteClient | undefined> {
    return (await this.store.read()).clients.find((client) => client.clientId === clientId);
  }

  async list(): Promise<Array<Omit<AuthorizedRemoteClient, "secret">>> {
    return (await this.store.read()).clients.map(({ secret: _secret, ...client }) => client);
  }

  async touch(clientId: string): Promise<void> {
    await this.store.update((data) => {
      const client = data.clients.find((candidate) => candidate.clientId === clientId);
      if (client) client.lastUsedAt = new Date().toISOString();
    });
  }

  async setRole(clientId: string, role: RemoteRole): Promise<boolean> {
    let updated = false;
    await this.store.update((data) => {
      const client = data.clients.find((candidate) => candidate.clientId === clientId);
      if (!client) return;
      client.role = role;
      updated = true;
    });
    return updated;
  }

  async revoke(clientId: string): Promise<boolean> {
    let revoked = false;
    await this.store.update((data) => {
      const clients = data.clients.filter((client) => client.clientId !== clientId);
      revoked = clients.length !== data.clients.length;
      return { clients };
    });
    return revoked;
  }
}

export class RemoteCredentialStore {
  private readonly store: JsonFileStore<RemoteCredentialsData>;

  constructor(path = TestbenchPaths.data("remote", "credentials.json")) {
    this.store = new JsonFileStore(path, () => ({ remotes: [] }));
  }

  async find(instanceId: string): Promise<RemoteClientCredential | undefined> {
    return (await this.store.read()).remotes.find((remote) => remote.instanceId === instanceId);
  }

  async save(credential: RemoteClientCredential): Promise<void> {
    await this.store.update((data) => ({
      remotes: [...data.remotes.filter((remote) => remote.instanceId !== credential.instanceId), credential],
    }));
  }

  async remove(instanceId: string): Promise<void> {
    await this.store.update((data) => ({
      remotes: data.remotes.filter((remote) => remote.instanceId !== instanceId),
    }));
  }

  async list(): Promise<Array<Omit<RemoteClientCredential, "secret">>> {
    return (await this.store.read()).remotes.map(({ secret: _secret, ...remote }) => remote);
  }

  static localClientName(): string {
    return hostname();
  }
}
