const root = document.documentElement;
const sidebar = document.querySelector("#sidebar");
const collapse = document.querySelector("#sidebar-collapse");
const menuToggle = document.querySelector("#menu-toggle");
const backdrop = document.querySelector("#sidebar-backdrop");
const collapsedStorageKey = "browser-testbench-sidebar-collapsed";
const authorizationStorageKey = "browser-testbench-token";
const connectionChangedEvent = "browser-testbench:connection-changed";
const authorizationChangedEvent = "browser-testbench:authorization-changed";
let remoteRefreshId = 0;

class AppShell {
  static initialize() {
    this.setCollapsed(localStorage.getItem(collapsedStorageKey) === "true");
    collapse.addEventListener("click", () => {
      const collapsed = !root.classList.contains("is-sidebar-collapsed");
      this.setCollapsed(collapsed);
      localStorage.setItem(collapsedStorageKey, String(collapsed));
    });
    menuToggle.addEventListener("click", () => this.setMobileOpen(!root.classList.contains("is-menu-open")));
    backdrop.addEventListener("click", () => this.setMobileOpen(false));
    sidebar.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => this.setMobileOpen(false)));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.setMobileOpen(false);
    });
    document.querySelector("#remote-banner-retry")?.addEventListener("click", () => this.retryRemote());
    document.querySelector("#remote-banner-disconnect")?.addEventListener("click", () => this.disconnectRemote());
    window.addEventListener(connectionChangedEvent, () => void this.refreshRemoteBanner());
    window.addEventListener(authorizationChangedEvent, () => void this.refreshRemoteBanner());
    void this.refreshRemoteBanner();
  }

  static async refreshRemoteBanner() {
    const refreshId = ++remoteRefreshId;
    try {
      const status = await this.request("/v1/connections/status");
      if (refreshId === remoteRefreshId) this.renderRemoteBanner(status);
    } catch {
      // The page itself communicates server availability; the banner stays unobtrusive.
    }
  }

  static renderRemoteBanner(status) {
    const banner = document.querySelector("#remote-banner");
    banner.hidden = status.mode !== "remote";
    if (!status.remote) return;
    document.querySelector("#remote-banner-name").textContent = status.remote.instanceName;
    document.querySelector("#remote-banner-detail").textContent =
      ` · ${this.platformLabel(status.remote.platform)} · ${status.remote.role} · ${status.reachable ? "connected" : "unreachable"} · ${status.remote.url}`;
    document.querySelector("#remote-banner-retry").hidden = status.reachable !== false;
  }

  static async retryRemote() {
    const button = document.querySelector("#remote-banner-retry");
    button.disabled = true;
    try {
      const status = await this.request("/v1/connections/status");
      this.renderRemoteBanner(status);
      if (status.reachable) window.location.reload();
    } catch {
      document.querySelector("#remote-banner-detail").textContent =
        " · retry failed · check the remote host and network";
    } finally {
      button.disabled = false;
    }
  }

  static async disconnectRemote() {
    const button = document.querySelector("#remote-banner-disconnect");
    button.disabled = true;
    try {
      await this.request("/v1/connections/active", { method: "DELETE" });
      window.location.reload();
    } catch {
      document.querySelector("#remote-banner-detail").textContent = " · disconnect failed · try again";
    } finally {
      button.disabled = false;
    }
  }

  static async request(path, options = {}) {
    const token = sessionStorage.getItem(authorizationStorageKey);
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers };
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  static platformLabel(platform) {
    return platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : platform === "linux"
          ? "Linux"
          : platform;
  }

  static setCollapsed(collapsed) {
    root.classList.toggle("is-sidebar-collapsed", collapsed);
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.querySelector("i").className = `fa-solid ${collapsed ? "fa-angles-right" : "fa-angles-left"}`;
    const label = collapsed ? "Expand menu" : "Collapse menu";
    collapse.setAttribute("aria-label", label);
    collapse.title = label;
  }

  static setMobileOpen(open) {
    root.classList.toggle("is-menu-open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open;
    if (open) sidebar.querySelector("a, button")?.focus();
    else if (document.activeElement && sidebar.contains(document.activeElement)) menuToggle.focus();
  }
}

AppShell.initialize();
