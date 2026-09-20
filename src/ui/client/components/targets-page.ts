import { defineComponent } from "vue";
import type { CheckStatus } from "../../../config/types.js";
import type { VerificationResultView, WorkbenchState, WorkbenchTestTarget } from "../../../setup/workbench-types.js";
import { ApiClient } from "../core/api-client.js";
import { workbenchStore, type VerificationState } from "../stores/workbench-store.js";
import { localized, translator } from "../core/translator.js";

const defaultApplicationUrl = "http://127.0.0.1:3000";

export const TargetsPage = defineComponent({
  template: "#targets-page-template",
  data: () => ({ store: workbenchStore, debugUrl: "", debugTargetId: "", runningAll: false }),
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
      if (!this.debugTarget || !this.workbench) return "";
      return this.shellCommand([
        "npx",
        this.workbench.packageName,
        "open",
        "--target",
        this.debugTarget.id,
        "--url",
        this.debugUrl.trim() || this.applicationUrlPlaceholder,
      ]);
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
