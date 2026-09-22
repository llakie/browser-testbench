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
import { localized, translator } from "../core/translator.js";

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
        ? translator.t("overview.remote.clients")
        : translator.t("overview.remote.connect");
    },
    remoteSummary(): string {
      if (this.connection.mode === "remote")
        return translator.t("overview.remote.manage", {
          instanceName: this.connection.remote?.instanceName ?? translator.t("overview.remote.remoteFallback"),
        });
      if (this.workbench?.remoteMode) return translator.t("overview.remote.manageLocal");
      return translator.t("overview.remote.useRemote");
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
        ? translator.t("overview.setupSummary", {
            completed,
            pending,
            pendingLabel: translator.t("overview.step", { count: pending }, pending),
          })
        : translator.t("overview.extensionsReady");
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
    t: translator.t.bind(translator),
    localized,
    mcpLabel(client: McpIntegrationStatus): string {
      return translator.message(client.labelMessage, client.label);
    },
    mcpDetail(client: McpIntegrationStatus): string {
      return translator.message(client.detailMessage, client.detail);
    },
    mcpInstruction(client: McpIntegrationStatus): string {
      return translator.message(client.instructionMessage, client.instruction);
    },
    statusIcon(status: CheckStatus): string {
      return { ready: "fa-check", action: "fa-triangle-exclamation", blocked: "fa-xmark", skip: "fa-minus" }[status];
    },
    actionStatus(status: SetupAction["status"]): string {
      return translator.t(`overview.actionStatus.${status}`);
    },
    actionStatusIcon(status: SetupAction["status"]): string {
      return actionIcons[status];
    },
    deviceKind(kind?: MobileDeviceKind): string {
      return kind ? translator.t(`overview.deviceKind.${kind}`) : "";
    },
    deviceState(state?: string): string {
      return state
        ? ({
            Booted: translator.t("overview.deviceState.Booted"),
            Shutdown: translator.t("overview.deviceState.Shutdown"),
            Creating: translator.t("overview.deviceState.Creating"),
            Connected: translator.t("overview.deviceState.Connected"),
            Wireless: translator.t("overview.deviceState.Wireless"),
            Unavailable: translator.t("overview.deviceState.Unavailable"),
            unauthorized: translator.t("overview.deviceState.unauthorized"),
            offline: translator.t("overview.deviceState.offline"),
            "no permissions": translator.t("overview.deviceState.no permissions"),
            Available: translator.t("overview.deviceState.Available"),
          }[state] ?? state)
        : "";
    },
    deviceMeta(device: TargetDeviceOption): string {
      return [
        this.deviceKind(device.deviceKind),
        device.platformVersion ? translator.t("overview.version", { version: device.platformVersion }) : "",
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
        return translator.t("overview.adminRequired");
      return localized(action, "detail") || translator.t("overview.manualStep");
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
        const details = failures
          .map(
            (item) =>
              `${localized(item, "label")}: ${localized(item, "detail") || translator.t("overview.manualStep")}`,
          )
          .join("; ");
        this.store.setNotice(
          failures.length
            ? translator.t("overview.setupFailed", { count: failures.length, details }, failures.length)
            : translator.t("overview.setupCompleted"),
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
        this.store.setNotice(translator.t("overview.mcpConnected", { clientName: client.label }), "success");
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
          this.store.setNotice(translator.t("overview.pairingPrompt"));
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
      if (!window.confirm(translator.t("overview.remote.revoke", { clientName: client.name }))) return;
      await this.perform(`revoke:${client.clientId}`, () =>
        this.store.mutate(`/v1/remote/clients/${encodeURIComponent(client.clientId)}`, { method: "DELETE" }),
      );
    },
    formatDate(
      value: string,
      options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
    ): string {
      return translator.formatDate(value, options);
    },
  },
});
