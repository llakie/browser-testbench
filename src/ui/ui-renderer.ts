import { join } from "node:path";
import { Eta } from "eta";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { RemoteUrlGuard } from "../remote/remote-url-guard.js";
import { PackageMetadata } from "../config/package-metadata.js";
import { LocaleResolver, Translator, type MessageKey } from "../i18n/translator.js";

const navigation: Array<{ id: string; href: string; label: MessageKey; icon: string }> = [
  { id: "dashboard", href: "/setup", label: "navigation.overview", icon: "fa-gauge-high" },
  { id: "targets", href: "/targets", label: "navigation.targets", icon: "fa-display" },
  { id: "docs", href: "/docs", label: "navigation.documentation", icon: "fa-book-open" },
];

const documentationNavigation: Array<{ href: string; label: MessageKey }> = [
  { href: "#start", label: "documentation.navigation.quickStart" },
  { href: "#remote", label: "documentation.navigation.remote" },
  { href: "#targets", label: "documentation.navigation.targetIds" },
  { href: "#automation", label: "documentation.navigation.automatedTests" },
  { href: "#debugging", label: "documentation.navigation.debugging" },
  { href: "#mobile", label: "documentation.navigation.mobile" },
  { href: "#physical-android", label: "documentation.navigation.android" },
  { href: "#physical-ios", label: "documentation.navigation.ios" },
  { href: "#ios-signing", label: "documentation.navigation.signing" },
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

  static setup(liveReload = false, acceptLanguage?: string | string[]): string {
    return this.page("dashboard", "navigation.overview", { refreshEnvironment: true }, liveReload, acceptLanguage);
  }

  static targets(liveReload = false, acceptLanguage?: string | string[]): string {
    return this.page("targets", "navigation.targets", {}, liveReload, acceptLanguage);
  }

  static documentation(liveReload = false, remoteExecution = false, acceptLanguage?: string | string[]): string {
    return this.page(
      "documentation",
      "navigation.documentation",
      {
        activePage: "docs",
        badgeIcon: "fa-book-open",
        badgeLabelKey: "common.status.localDocumentation",
        localNetworkAddress: remoteExecution ? undefined : RemoteUrlGuard.lanAddress(),
        remoteExecution,
      },
      liveReload,
      acceptLanguage,
    );
  }

  private static page(
    template: string,
    pageTitleKey: MessageKey,
    data: Record<string, unknown> = {},
    liveReload = false,
    acceptLanguage?: string | string[],
  ): string {
    const locale = LocaleResolver.resolve(acceptLanguage);
    const translator = new Translator(locale);
    const t = (key: MessageKey, parameters = {}, count?: number) => translator.t(key, parameters, count);
    const activePage = (data.activePage as string | undefined) ?? template;
    const shared = {
      title: t("common.productName"),
      pageTitle: t(pageTitleKey),
      locale,
      t,
      activePage,
      navigation: navigation.map((item) => ({ ...item, label: t(item.label) })),
      subnavigation:
        activePage === "docs" ? documentationNavigation.map((item) => ({ ...item, label: t(item.label) })) : [],
      badgeIcon: "fa-circle-notch fa-spin",
      badgeLabel: t((data.badgeLabelKey as MessageKey | undefined) ?? "common.status.checkingSystem"),
      liveReload,
      version: PackageMetadata.VERSION,
      ...data,
      scripts: ["/ui-assets/app.js", ...((data.scripts as string[] | undefined) ?? [])],
    };
    const templates = liveReload ? this.liveTemplates : this.cachedTemplates;
    const content = templates.render(`./pages/${template}`, shared);
    return templates.render("./layout", { ...shared, content });
  }
}
