export type RemoteRole = "control" | "admin";

export interface RemoteInstance {
  instanceId: string;
  name: string;
  url: string;
  platform: NodeJS.Platform;
  architecture: string;
  version: string;
  apiVersion: number;
  authentication: "pairing";
}

export interface RemoteClientCredential {
  instanceId: string;
  instanceName: string;
  platform: NodeJS.Platform;
  architecture: string;
  version: string;
  url: string;
  clientId: string;
  clientName: string;
  role: RemoteRole;
  secret: string;
}

export interface AuthorizedRemoteClient {
  clientId: string;
  name: string;
  role: RemoteRole;
  secret: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface RemotePrincipal {
  clientId: string;
  name: string;
  role: RemoteRole;
  local: boolean;
}

export interface PairingChallenge {
  pairingId: string;
  serverPublicKey: string;
  expiresAt: string;
}

export interface PairingCompletion {
  pairingId: string;
  clientId: string;
  clientName: string;
  role: RemoteRole;
  proof: string;
}

export interface EncryptedCredential {
  iv: string;
  ciphertext: string;
  authenticationTag: string;
}
