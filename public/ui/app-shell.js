const root = document.documentElement;
const sidebar = document.querySelector("#sidebar");
const collapse = document.querySelector("#sidebar-collapse");
const menuToggle = document.querySelector("#menu-toggle");
const backdrop = document.querySelector("#sidebar-backdrop");
const collapsedStorageKey = "browser-testbench-sidebar-collapsed";

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
    document.querySelector("#remote-banner-disconnect")?.addEventListener("click", () => this.disconnectRemote());
    void this.refreshRemoteBanner();
  }

  static async refreshRemoteBanner() {
    try {
      const response = await fetch("/v1/connections/status");
      if (!response.ok) return;
      const status = await response.json();
      const banner = document.querySelector("#remote-banner");
      banner.hidden = status.mode !== "remote";
      if (!status.remote) return;
      document.querySelector("#remote-banner-name").textContent = status.remote.instanceName;
      document.querySelector("#remote-banner-detail").textContent =
        ` · ${status.remote.role} · ${status.reachable ? "connected" : "unreachable"} · ${status.remote.url}`;
    } catch {
      // The page itself communicates server availability; the banner stays unobtrusive.
    }
  }

  static async disconnectRemote() {
    const button = document.querySelector("#remote-banner-disconnect");
    button.disabled = true;
    try {
      const response = await fetch("/v1/connections/active", { method: "DELETE" });
      if (!response.ok) throw new Error("Disconnect failed.");
      window.location.reload();
    } finally {
      button.disabled = false;
    }
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
