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
