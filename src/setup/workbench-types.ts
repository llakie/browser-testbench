import type { DoctorCheck, TargetDefinition, TargetName, TestTargetInfo } from "../config/types.js";
import type { AuthorizedRemoteClient, ConnectionStatus, RemoteInstance, RemoteRole } from "../remote/remote-types.js";
import type { McpIntegrationStatus } from "./mcp-integration-service.js";
import type { SetupAction } from "./setup-types.js";

export interface WorkbenchTarget extends TargetDefinition {
  check?: DoctorCheck;
}

export interface WorkbenchTestTarget extends TestTargetInfo {
  busy?: boolean;
}

export interface WorkbenchBaseState {
  platform: NodeJS.Platform;
  platformLabel: string;
  architecture: string;
  mcpClients: McpIntegrationStatus[];
  targets: WorkbenchTarget[];
  checks: DoctorCheck[];
  actions: SetupAction[];
  testTargets: WorkbenchTestTarget[];
  clientInstallCommand: string;
  packageName: string;
}

export interface PairingRequestView {
  pairingId: string;
  clientName: string;
  role: RemoteRole;
  code: string;
  expiresAt: string;
}

export type AuthorizedRemoteClientView = Omit<AuthorizedRemoteClient, "secret"> & { connected: boolean };

export interface WorkbenchState extends WorkbenchBaseState {
  localNetworkAddress?: string;
  connection: ConnectionStatus;
  permissions: { control: boolean; configure: boolean };
  remoteMode: boolean;
  pairingRequests: PairingRequestView[];
  authorizedClients: AuthorizedRemoteClientView[];
}

export type RemoteDiscoveryResult = RemoteInstance;

export interface VerificationResultView {
  target: TargetName | string;
  status: "passed";
  durationMs: number;
  runtime: Record<string, unknown>;
}
