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
  { href: "#remote", label: "Remote Testbench" },
  { href: "#targets", label: "Target-IDs" },
  { href: "#automation", label: "Automated tests" },
  { href: "#debugging", label: "Interactive debugging" },
  { href: "#mobile", label: "Mobile devices" },
];

export class UiRenderer {
  private static readonly cachedTemplates = new Eta({
    views: join(TestbenchPaths.projectRoot, "templates", "ui"),
    cache: true,
  });
  private static readonly liveTemplates = new Eta({
    views: join(TestbenchPaths.projectRoot, "templates", "ui"),
    cache: false,
  });

  static setup(liveReload = false): string {
    return this.page(
      "dashboard",
      "Overview",
      { refreshEnvironment: true, scripts: ["/ui-assets/environment-events.js", "/ui-assets/setup.js"] },
      liveReload,
    );
  }

  static targets(liveReload = false): string {
    return this.page(
      "targets",
      "Test targets",
      { scripts: ["/ui-assets/environment-events.js", "/ui-assets/setup.js"] },
      liveReload,
    );
  }

  static documentation(liveReload = false): string {
    return this.page(
      "documentation",
      "Documentation",
      {
        activePage: "docs",
        badgeIcon: "fa-book-open",
        badgeLabel: "Local documentation",
        subnavigation: documentationNavigation,
      },
      liveReload,
    );
  }

  private static page(
    template: string,
    pageTitle: string,
    data: Record<string, unknown> = {},
    liveReload = false,
  ): string {
    const activePage = (data.activePage as string | undefined) ?? template;
    const shared = {
      title: "Browser Testbench",
      pageTitle,
      activePage,
      navigation,
      subnavigation: [],
      badgeIcon: "fa-circle-notch fa-spin",
      badgeLabel: "Checking system",
      ...data,
      scripts: [
        ...((data.scripts as string[] | undefined) ?? []),
        ...(liveReload ? ["/ui-assets/live-reload.js"] : []),
      ],
    };
    const templates = liveReload ? this.liveTemplates : this.cachedTemplates;
    const content = templates.render(`./pages/${template}`, shared);
    return templates.render("./layout", { ...shared, content });
  }
}
