import { defineComponent } from "vue";
import type { CheckStatus } from "../../../config/types.js";
import type { VerificationResultView, WorkbenchState, WorkbenchTestTarget } from "../../../setup/workbench-types.js";
import { ApiClient } from "../core/api-client.js";
import { workbenchStore, type VerificationState } from "../stores/workbench-store.js";
import { localized, translator } from "../core/translator.js";

const defaultApplicationUrl = "http://127.0.0.1:3000";

interface DebugToolsView {
  tool?: string;
  automatic?: boolean;
  url?: string;
}

interface DebugSessionView {
  id: string;
  target: string;
  createdAt: string;
  runtime: Record<string, unknown>;
  devtools?: DebugToolsView;
}

export const TargetsPage = defineComponent({
  template: "#targets-page-template",
  data: () => ({
    store: workbenchStore,
    debugUrl: "",
    debugTargetId: "",
    debugSessions: [] as DebugSessionView[],
    debugSessionsRequestId: 0,
    loadingDebugSessions: false,
    startingDebugSession: false,
    closingDebugSessionId: "",
    runningAll: false,
  }),
  computed: {
    workbench(): WorkbenchState | null {
      return this.store.workbench;
    },
    readyTargets(): WorkbenchTestTarget[] {
      return this.workbench?.testTargets.filter((target) => target.ready) ?? [];
    },
    debugTarget(): WorkbenchTestTarget | undefined {
      return this.workbench?.testTargets.find((target) => target.id === this.debugTargetId);
    },
    applicationUrlPlaceholder(): string {
      if (this.workbench?.connection.mode !== "remote") return defaultApplicationUrl;
      const address = this.workbench.localNetworkAddress;
      return address ? `http://${address}:3000` : "http://YOUR-LAN-IP:3000";
    },
    networkApplicationUrl(): string | undefined {
      const address = this.workbench?.localNetworkAddress;
      return this.workbench?.connection.mode === "remote" && address ? `http://${address}:3000` : undefined;
    },
    debugCommand(): string {
      if (!this.debugTarget || !this.workbench || !this.debugApplicationUrl) return "";
      return this.shellCommand([
        "npx",
        this.workbench.packageName,
        "open",
        "--target",
        this.debugTarget.id,
        "--url",
        this.debugApplicationUrl,
      ]);
    },
    debugApplicationUrl(): string {
      return this.debugUrl.trim();
    },
    canStartDebugSession(): boolean {
      return Boolean(
        this.debugTarget?.ready &&
        this.debugApplicationUrl &&
        !this.debugTarget.busy &&
        this.workbench?.permissions.control &&
        !this.startingDebugSession &&
        !this.closingDebugSessionId &&
        !this.store.busy,
      );
    },
    debugNote(): string {
      const notes: Partial<Record<WorkbenchTestTarget["browser"], string>> = {
        "safari-ios": translator.t("targets.devtools.ios"),
        "chrome-android": translator.t("targets.devtools.android"),
      };
      return (
        (this.debugTarget ? notes[this.debugTarget.browser] : undefined) ?? translator.t("targets.devtools.desktop")
      );
    },
    clientExample(): string {
      if (!this.workbench) return "";
      const desktop = this.readyTargets.find((target) => target.kind === "desktop");
      const mobile = this.readyTargets.find((target) => target.kind === "mobile");
      const requested = [desktop?.id, mobile?.id].flatMap((id) => (id ? [id] : []));
      const examples = [...new Set(requested.length ? requested : ["chrome"])];
      return `import { RemoteTestbench } from "${this.workbench.packageName}/client";

const testbench = new RemoteTestbench();
const targets = await testbench.availableTargets(${JSON.stringify(examples, null, 2)});

for (const target of targets) {
  const browser = await testbench.open({ target, url: "${this.applicationUrlPlaceholder}", headless: true });

  try {
    await browser.click('button[type="submit"]');
    await browser.waitForText("Welcome");
    await browser.screenshot(\`artifacts/login-\${target}.png\`);
  } finally {
    await browser.close();
  }
}`;
    },
  },
  watch: {
    workbench: {
      immediate: true,
      handler(value: WorkbenchState | null): void {
        const targets = value?.testTargets ?? [];
        if (!targets.some((target) => target.id === this.debugTargetId))
          this.debugTargetId = (targets.find((target) => target.ready) ?? targets[0])?.id ?? "";
        if (value) void this.loadDebugSessions();
      },
    },
  },
  methods: {
    t: translator.t.bind(translator),
    localized,
    statusIcon(status: CheckStatus): string {
      return { ready: "fa-check", action: "fa-triangle-exclamation", blocked: "fa-xmark", skip: "fa-minus" }[status];
    },
    availability(target: WorkbenchTestTarget): string {
      if (target.busy) return translator.t("targets.status.busy");
      const remote = this.workbench?.connection.mode === "remote";
      return {
        ready: translator.t(remote ? "targets.status.readyRemote" : "targets.status.readyLocal"),
        action: translator.t("targets.status.action"),
        blocked: translator.t("targets.status.blocked"),
        skip: translator.t(remote ? "targets.status.skipRemote" : "targets.status.skipLocal"),
      }[target.status];
    },
    verification(target: WorkbenchTestTarget): VerificationState | undefined {
      return this.store.state.verification[target.id];
    },
    verificationMessage(target: WorkbenchTestTarget): string {
      const current = this.verification(target);
      if (current) return current.message;
      return target.verifiedAt
        ? translator.t("targets.lastVerified", {
            date: translator.formatDate(target.verifiedAt, { dateStyle: "medium", timeStyle: "short" }),
          })
        : "";
    },
    verificationIcon(target: WorkbenchTestTarget): string {
      const status = this.verification(target)?.status;
      return status === "running" ? "fa-spinner fa-spin" : status === "failed" ? "fa-circle-xmark" : "fa-circle-check";
    },
    progress(target: WorkbenchTestTarget): string {
      if (target.browser === "safari-ios") return translator.t("targets.runningIos");
      if (target.browser === "chrome-android")
        return target.deviceKind === "physical"
          ? translator.t("targets.runningAndroidDevice")
          : translator.t("targets.runningAndroidEmulator");
      return translator.t("targets.running");
    },
    debugSessionTarget(session: DebugSessionView): WorkbenchTestTarget | undefined {
      return this.workbench?.testTargets.find((target) => target.id === session.target);
    },
    debugSessionLabel(session: DebugSessionView): string {
      const target = this.debugSessionTarget(session);
      return target ? localized(target, "label") : session.target;
    },
    debugSessionStartedAt(session: DebugSessionView): string {
      return translator.formatDate(session.createdAt, { dateStyle: "medium", timeStyle: "short" });
    },
    debugSessionNote(session: DebugSessionView): string {
      if (this.workbench?.connection.mode === "remote") return translator.t("targets.devtools.remote");
      const browser = this.debugSessionTarget(session)?.browser;
      return browser === "safari-ios"
        ? translator.t("targets.devtools.ios")
        : browser === "chrome-android"
          ? translator.t("targets.devtools.android")
          : translator.t("targets.devtools.desktop");
    },
    openableDevToolsUrl(session: DebugSessionView): string | undefined {
      const url = session.devtools?.url;
      return this.workbench?.connection.mode === "local" && url && /^https?:\/\//.test(url) ? url : undefined;
    },
    async loadDebugSessions(): Promise<void> {
      const requestId = ++this.debugSessionsRequestId;
      this.loadingDebugSessions = true;
      try {
        const sessions = await ApiClient.request<DebugSessionView[]>("/v1/sessions");
        const detailed = await Promise.all(
          sessions.map(async (session) => ({
            ...session,
            devtools: await ApiClient.request<DebugToolsView>(`/v1/sessions/${session.id}/devtools`).catch(
              () => undefined,
            ),
          })),
        );
        if (requestId === this.debugSessionsRequestId) this.debugSessions = detailed;
      } catch (error) {
        if (requestId === this.debugSessionsRequestId) this.store.setNotice(this.store.message(error), "error");
      } finally {
        if (requestId === this.debugSessionsRequestId) this.loadingDebugSessions = false;
      }
    },
    async startDebugSession(): Promise<void> {
      const target = this.debugTarget;
      const url = this.debugApplicationUrl;
      if (!target || !url || !this.canStartDebugSession) return;
      this.startingDebugSession = true;
      try {
        const session = await ApiClient.request<DebugSessionView>("/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ target: target.id }),
        });
        await this.loadDebugSessions();
        try {
          await ApiClient.request(`/v1/sessions/${session.id}/navigate`, {
            method: "POST",
            body: JSON.stringify({ url }),
          });
        } catch (error) {
          this.store.setNotice(
            translator.t("targets.page.debugSessionNavigationFailed", {
              targetName: localized(target, "label"),
              message: this.store.message(error),
            }),
            "warning",
          );
          return;
        }
        this.store.setNotice(
          translator.t("targets.page.debugSessionStarted", { targetName: localized(target, "label") }),
          "success",
        );
      } catch (error) {
        this.store.setNotice(this.store.message(error), "error");
      } finally {
        this.startingDebugSession = false;
      }
    },
    async closeDebugSession(session: DebugSessionView): Promise<void> {
      this.closingDebugSessionId = session.id;
      try {
        await ApiClient.request(`/v1/sessions/${session.id}`, { method: "DELETE" });
        await this.loadDebugSessions();
        this.store.setNotice(
          translator.t("targets.page.debugSessionClosed", { targetName: this.debugSessionLabel(session) }),
          "success",
        );
      } catch (error) {
        this.store.setNotice(this.store.message(error), "error");
        await this.loadDebugSessions();
      } finally {
        this.closingDebugSessionId = "";
      }
    },
    async runVerification(target: WorkbenchTestTarget): Promise<VerificationResultView> {
      this.store.state.verification[target.id] = { status: "running", message: this.progress(target) };
      try {
        const result = await ApiClient.request<VerificationResultView>("/v1/verify", {
          method: "POST",
          body: JSON.stringify({
            target: target.id,
            ...(target.kind === "desktop" && target.browser !== "safari" ? { headless: true } : {}),
          }),
        });
        this.store.state.verification[target.id] = {
          status: "passed",
          message: translator.t("targets.passed", { duration: result.durationMs }),
        };
        return result;
      } catch (error) {
        this.store.state.verification[target.id] = {
          status: "failed",
          message: translator.t("targets.failed", { message: this.store.message(error) }),
        };
        throw error;
      }
    },
    async verifyTarget(target: WorkbenchTestTarget): Promise<void> {
      this.store.state.busy = true;
      try {
        const result = await this.runVerification(target);
        delete this.store.state.verification[target.id];
        this.store.setNotice(
          translator.t("targets.targetPassed", { targetName: localized(target, "label"), duration: result.durationMs }),
          "success",
        );
        await this.store.refresh();
      } catch (error) {
        this.store.setNotice(this.store.message(error), "error");
      } finally {
        this.store.state.busy = false;
      }
    },
    async verifyAll(): Promise<void> {
      const failures: Array<{ target: WorkbenchTestTarget; error: unknown }> = [];
      this.store.state.busy = true;
      this.runningAll = true;
      try {
        for (const target of this.readyTargets) {
          try {
            await this.runVerification(target);
          } catch (error) {
            failures.push({ target, error });
          }
        }
        for (const target of this.readyTargets)
          if (this.verification(target)?.status === "passed") delete this.store.state.verification[target.id];
        await this.store.refresh();
        this.store.setNotice(
          failures.length
            ? translator.t("targets.partialResult", {
                passed: this.readyTargets.length - failures.length,
                total: this.readyTargets.length,
                failed: failures.length,
              })
            : translator.t("targets.allPassed", { count: this.readyTargets.length }, this.readyTargets.length),
          failures.length ? "error" : "success",
        );
      } finally {
        this.runningAll = false;
        this.store.state.busy = false;
      }
    },
    shellCommand(parts: string[]): string {
      return parts.map((part) => (/\s|"/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)).join(" ");
    },
  },
});
