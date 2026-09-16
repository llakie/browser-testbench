import { join } from "node:path";
import { Eta } from "eta";
import { TestbenchPaths } from "../infrastructure/paths.js";

const navigation = [
  { id: "dashboard", href: "/setup", label: "Overview", icon: "fa-gauge-high" },
  { id: "targets", href: "/targets", label: "Test targets", icon: "fa-display" },
  { id: "docs", href: "/docs", label: "Documentation", icon: "fa-book-open" },
];

const documentationNavigation = [
  { href: "#start", label: "Quick start" },
  { href: "#targets", label: "Target-IDs" },
  { href: "#automation", label: "Automated tests" },
  { href: "#debugging", label: "Interactive debugging" },
  { href: "#mobile", label: "Mobile devices" },
];

export class UiRenderer {
  private static readonly templates = new Eta({
    views: join(TestbenchPaths.projectRoot, "templates", "ui"),
    cache: true,
  });

  static setup(): string {
    return this.page("dashboard", "Overview", { scripts: ["/ui-assets/setup.js"] });
  }

  static targets(): string {
    return this.page("targets", "Test targets", { scripts: ["/ui-assets/setup.js"] });
  }

  static documentation(): string {
    return this.page("documentation", "Documentation", {
      activePage: "docs",
      badgeIcon: "fa-book-open",
      badgeLabel: "Local documentation",
      subnavigation: documentationNavigation,
    });
  }

  private static page(template: string, pageTitle: string, data: Record<string, unknown> = {}): string {
    const activePage = (data.activePage as string | undefined) ?? template;
    const shared = {
      title: "Browser Testbench",
      pageTitle,
      activePage,
      navigation,
      subnavigation: [],
      scripts: [],
      badgeIcon: "fa-circle-notch fa-spin",
      badgeLabel: "Checking system",
      ...data,
    };
    const content = this.templates.render(`./pages/${template}`, shared);
    return this.templates.render("./layout", { ...shared, content });
  }
}
