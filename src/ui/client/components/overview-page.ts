import { defineComponent } from "vue";
import type { CheckStatus, MobileDeviceKind, TargetDeviceOption } from "../../../config/types.js";
import type { McpIntegrationStatus } from "../../../setup/mcp-integration-service.js";
import type { SetupAction } from "../../../setup/setup-types.js";
import type {
  AuthorizedRemoteClientView,
  RemoteDiscoveryResult,
  WorkbenchState,
} from "../../../setup/workbench-types.js";
import type { ConnectionStatus, PairingRequired } from "../../../remote/remote-types.js";
import { ApiClient } from "../core/api-client.js";
import { workbenchStore } from "../stores/workbench-store.js";

const actionLabels: Record<SetupAction["status"], string> = {
  completed: "Installed",
  planned: "Not installed",
  manual: "Action required",
  failed: "Failed",
};

const actionIcons: Record<SetupAction["status"], string> = {
  completed: "fa-check",
  planned: "fa-clock",
  manual: "fa-triangle-exclamation",
  failed: "fa-xmark",
};

export const OverviewPage = defineComponent({
  template: "#overview-page-template",
  data: () => ({
    store: workbenchStore,
    remoteUrl: "",
    requestAdmin: false,
    pairingCode: "",
    pendingPairingId: "",
    discovered: null as RemoteDiscoveryResult[] | null,
    selectedMcpClientId: "",
    actionBusy: "",
    pairingExpiryTimer: undefined as number | undefined,
  }),
  computed: {
    workbench(): WorkbenchState | null {
      return this.store.workbench;
    },
    connection(): ConnectionStatus {
      return this.store.connection;
    },
    remotePanelVisible(): boolean {
      return !(this.connection.mode === "remote" && !this.workbench?.permissions.configure);
    },
    remoteTitle(): string {
      return this.connection.mode === "remote" || this.workbench?.remoteMode
        ? "Connected test clients"
        : "Connect to a central Testbench";
    },
    remoteSummary(): string {
      if (this.connection.mode === "remote")
        return `Manage clients paired with ${this.connection.remote?.instanceName ?? "the remote Testbench"}.`;
      if (this.workbench?.remoteMode) return "Pair and manage clients that use this Testbench over the network.";
      return "Use browsers and devices provided by another computer on your network.";
    },
    managesClients(): boolean {
      return Boolean(this.workbench?.remoteMode || this.connection.mode === "remote");
    },
    selectedMcpClient(): McpIntegrationStatus | undefined {
      const clients = this.workbench?.mcpClients ?? [];
      return clients.find((client) => client.id === this.selectedMcpClientId) ?? clients[0];
    },
    setupSummary(): string {
      const actions = this.workbench?.actions ?? [];
      const completed = actions.filter((action) => action.status === "completed").length;
      const pending = actions.length - completed;
      return pending
        ? `${completed} installed · ${pending} ${pending === 1 ? "step" : "steps"} remaining`
        : "All required extensions are installed.";
    },
  },
  watch: {
    workbench: {
      immediate: true,
      handler(value: WorkbenchState | null): void {
        clearTimeout(this.pairingExpiryTimer);
        const expiry = Math.min(...(value?.pairingRequests ?? []).map((request) => Date.parse(request.expiresAt)));
        if (Number.isFinite(expiry))
          this.pairingExpiryTimer = window.setTimeout(
            () => void this.store.refresh({ background: true }),
            Math.max(0, expiry - Date.now() + 50),
          );
        if (!value?.mcpClients.length) return;
        const previous = value.mcpClients.find((client) => client.id === this.selectedMcpClientId);
        const preferred =
          previous ??
          value.mcpClients.find((client) => client.current) ??
          value.mcpClients.find((client) => client.installed && client.automatic) ??
          value.mcpClients[0];
        if (preferred) this.selectedMcpClientId = preferred.id;
      },
    },
  },
  beforeUnmount(): void {
    clearTimeout(this.pairingExpiryTimer);
  },
  methods: {
    statusIcon(status: CheckStatus): string {
      return { ready: "fa-check", action: "fa-triangle-exclamation", blocked: "fa-xmark", skip: "fa-minus" }[status];
    },
    actionStatus(status: SetupAction["status"]): string {
      return actionLabels[status];
    },
    actionStatusIcon(status: SetupAction["status"]): string {
      return actionIcons[status];
    },
    deviceKind(kind?: MobileDeviceKind): string {
      return kind ? { physical: "Physical device", emulator: "Emulator", simulator: "Simulator" }[kind] : "";
    },
    deviceState(state?: string): string {
      return state
        ? ({
            Booted: "Running",
            Shutdown: "Shut down",
            Creating: "Creating",
            Connected: "Connected via USB",
            Wireless: "Connected wirelessly",
            Unavailable: "Reconnect and unlock the device",
            unauthorized: "USB debugging authorization required",
            offline: "Device offline",
            "no permissions": "USB permission required",
            Available: "Available",
          }[state] ?? state)
        : "";
    },
    deviceMeta(device: TargetDeviceOption): string {
      return [
        this.deviceKind(device.deviceKind),
        device.platformVersion ? `Version ${device.platformVersion}` : "",
        this.deviceState(device.state),
      ]
        .filter(Boolean)
        .join(" · ");
    },
    deviceConfig(device: TargetDeviceOption): string {
      const { iosTeamId: _team, iosSigningId: _signing, wdaBundleId: _bundle, ...config } = device.config;
      return JSON.stringify(config);
    },
    physicalDeviceDocumentation(checkId: string): string | undefined {
      return {
        "safari-ios": "/docs#physical-ios",
        "chrome-android": "/docs#physical-android",
      }[checkId];
    },
    isInstallable(action: SetupAction): boolean {
      return Boolean(
        action.automatic &&
        action.status === "planned" &&
        action.targets?.length &&
        this.workbench?.permissions.configure,
      );
    },
    setupBusy(action: SetupAction): boolean {
      return this.actionBusy === `setup:${(action.targets ?? []).join(",")}`;
    },
    actionDetail(action: SetupAction): string {
      if (!this.workbench?.permissions.configure && action.status !== "completed")
        return "Administrative setup requires an admin pairing.";
      return action.detail ?? "This step must be completed manually.";
    },
    async perform<T>(key: string, operation: () => Promise<T>): Promise<T | undefined> {
      this.actionBusy = key;
      try {
        return await operation();
      } catch (error) {
        this.store.setNotice(this.store.message(error), "error");
      } finally {
        this.actionBusy = "";
      }
    },
    async setup(action: SetupAction): Promise<void> {
      const targets = action.targets ?? [];
      await this.perform(`setup:${targets.join(",")}`, async () => {
        const actions = await this.store.mutate<SetupAction[]>("/v1/workbench/setup", {
          method: "POST",
          body: JSON.stringify({ targets }),
        });
        const failures = actions.filter((item) => item.status === "failed");
        this.store.setNotice(
          failures.length ? `${failures.length} setup steps failed.` : "Setup completed.",
          failures.length ? "error" : "success",
        );
      });
    },
    async registerMcp(): Promise<void> {
      const client = this.selectedMcpClient;
      if (!client) return;
      await this.perform("mcp", async () => {
        await this.store.mutate<McpIntegrationStatus>("/v1/workbench/mcp", {
          method: "POST",
          body: JSON.stringify({ client: client.id }),
        });
        this.store.setNotice(`${client.label} is connected to Browser Testbench.`, "success");
      });
    },
    async discoverRemotes(): Promise<void> {
      await this.perform("discover", async () => {
        this.discovered = await ApiClient.request<RemoteDiscoveryResult[]>("/v1/connections/discover");
      });
    },
    async connectManual(): Promise<void> {
      await this.perform("connect-manual", async () => {
        const instance = await ApiClient.request<RemoteDiscoveryResult>(
          `/v1/connections/identity?server=${encodeURIComponent(this.remoteUrl)}`,
        );
        await this.connectRemote(instance);
      });
    },
    async connectRemote(instance: RemoteDiscoveryResult): Promise<void> {
      await this.perform(`connect:${instance.instanceId}`, async () => {
        const result = await ApiClient.request<ConnectionStatus | PairingRequired>("/v1/connections/connect", {
          method: "POST",
          body: JSON.stringify({ instance, role: this.requestAdmin ? "admin" : "control" }),
        });
        if ("pairingRequired" in result) {
          this.pendingPairingId = result.pairingId;
          this.store.setNotice("Enter the pairing code shown on the remote computer.");
          this.$nextTick(() => document.querySelector<HTMLInputElement>("#pairing-code")?.focus());
          return;
        }
        await this.store.refresh({ analyze: true });
      });
    },
    async completePairing(): Promise<void> {
      await this.perform("pair", async () => {
        await ApiClient.request<ConnectionStatus>("/v1/connections/pair", {
          method: "POST",
          body: JSON.stringify({ pairingId: this.pendingPairingId, code: this.pairingCode }),
        });
        this.pairingCode = "";
        this.pendingPairingId = "";
        await this.store.refresh({ analyze: true });
      });
    },
    async setRole(client: AuthorizedRemoteClientView): Promise<void> {
      const role = client.role === "admin" ? "control" : "admin";
      await this.perform(`role:${client.clientId}`, () =>
        this.store.mutate(`/v1/remote/clients/${encodeURIComponent(client.clientId)}`, {
          method: "PUT",
          body: JSON.stringify({ role }),
        }),
      );
    },
    async revoke(client: AuthorizedRemoteClientView): Promise<void> {
      if (!window.confirm(`Revoke access for ${client.name}?`)) return;
      await this.perform(`revoke:${client.clientId}`, () =>
        this.store.mutate(`/v1/remote/clients/${encodeURIComponent(client.clientId)}`, { method: "DELETE" }),
      );
    },
    formatDate(
      value: string,
      options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
    ): string {
      return new Intl.DateTimeFormat("en", options).format(new Date(value));
    },
  },
});
