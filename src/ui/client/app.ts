import { createApp, defineComponent, type Component } from "vue";
import type { ConnectionStatus } from "../../remote/remote-types.js";
import { ApiClient } from "./core/api-client.js";
import { LiveReloadClient } from "./core/live-reload.js";
import { CommandBlock } from "./components/command-block.js";
import { OverviewPage } from "./components/overview-page.js";
import { TargetsPage } from "./components/targets-page.js";
import { workbenchStore } from "./stores/workbench-store.js";

const collapsedStorageKey = "browser-testbench-sidebar-collapsed";
const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) throw new Error("Browser Testbench UI root was not found.");
const activePage = appElement.dataset.page ?? "dashboard";
LiveReloadClient.start(appElement.dataset.liveReload === "true");

if (activePage === "dashboard") {
  workbenchStore.state.loading = true;
  workbenchStore.state.analyzing = true;
}

const attachTemplate = (component: Component, selector: string): void => {
  const template = document.querySelector<HTMLTemplateElement>(selector);
  (component as Component & { template: string }).template = template?.innerHTML ?? "";
};

attachTemplate(OverviewPage, "#overview-page-template");
attachTemplate(TargetsPage, "#targets-page-template");

const RootApp = defineComponent({
  data: () => ({
    store: workbenchStore,
    page: activePage,
    sidebarCollapsed: localStorage.getItem(collapsedStorageKey) === "true",
    mobileMenuOpen: false,
    shellBusy: false,
  }),
  computed: {
    connection(): ConnectionStatus {
      return this.store.connection;
    },
    badgeIcon(): string {
      if (this.page === "docs") return "fa-book-open";
      if (!this.store.workbench) return "fa-circle-notch fa-spin";
      return this.store.workbench.platform === "darwin"
        ? "fa-laptop"
        : this.store.workbench.platform === "win32"
          ? "fa-desktop"
          : "fa-terminal";
    },
    badgeLabel(): string {
      if (this.page === "docs") return "Local documentation";
      const workbench = this.store.workbench;
      return workbench ? `${workbench.platformLabel} · ${workbench.architecture}` : "Checking system";
    },
    remoteBannerDetail(): string {
      const remote = this.connection.remote;
      if (!remote) return "";
      return ` · ${this.platformLabel(remote.platform)} · ${remote.role} · ${this.connection.reachable === false ? "unreachable" : "connected"} · ${remote.url}`;
    },
  },
  mounted(): void {
    this.applySidebar();
    document.addEventListener("keydown", this.onKeydown);
    window.addEventListener("browser-testbench:connection-changed", this.refreshConnection);
    window.addEventListener("browser-testbench:authorization-changed", this.refreshConnection);
    document.querySelector("#sidebar")?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a")) this.closeMobileMenu();
    });
    void this.store.initialize(this.page !== "docs");
  },
  beforeUnmount(): void {
    document.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("browser-testbench:connection-changed", this.refreshConnection);
    window.removeEventListener("browser-testbench:authorization-changed", this.refreshConnection);
  },
  methods: {
    platformLabel(platform: NodeJS.Platform): string {
      if (platform === "darwin") return "macOS";
      if (platform === "win32") return "Windows";
      if (platform === "linux") return "Linux";
      return platform;
    },
    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      localStorage.setItem(collapsedStorageKey, String(this.sidebarCollapsed));
      this.applySidebar();
    },
    applySidebar(): void {
      document.documentElement.classList.toggle("is-sidebar-collapsed", this.sidebarCollapsed);
    },
    toggleMobileMenu(): void {
      this.mobileMenuOpen = !this.mobileMenuOpen;
      document.documentElement.classList.toggle("is-menu-open", this.mobileMenuOpen);
      if (this.mobileMenuOpen)
        this.$nextTick(() => document.querySelector<HTMLElement>("#sidebar a, #sidebar button")?.focus());
    },
    closeMobileMenu(): void {
      this.mobileMenuOpen = false;
      document.documentElement.classList.remove("is-menu-open");
    },
    onKeydown(event: KeyboardEvent): void {
      if (event.key === "Escape") this.closeMobileMenu();
    },
    refreshConnection(): void {
      void this.store.refreshConnection();
    },
    async retryRemote(): Promise<void> {
      this.shellBusy = true;
      try {
        await this.store.refreshConnection();
        if (this.page !== "docs" && this.connection.reachable) await this.store.refresh({ analyze: true });
      } finally {
        this.shellBusy = false;
      }
    },
    async disconnectRemote(): Promise<void> {
      this.shellBusy = true;
      try {
        await ApiClient.request<ConnectionStatus>("/v1/connections/active", { method: "DELETE" });
        this.store.clearNotice();
        await (this.page === "docs" ? this.store.refreshConnection() : this.store.refresh({ analyze: true }));
      } catch (error) {
        this.store.setNotice(this.store.message(error), "error");
      } finally {
        this.shellBusy = false;
      }
    },
  },
});

const app = createApp(RootApp);
app.component("command-block", CommandBlock);
app.component("overview-page", OverviewPage);
app.component("targets-page", TargetsPage);
app.mount(appElement);
