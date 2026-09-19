import { defineComponent } from "vue";
import type { CheckStatus } from "../../../config/types.js";
import type { VerificationResultView, WorkbenchState, WorkbenchTestTarget } from "../../../setup/workbench-types.js";
import { ApiClient } from "../core/api-client.js";
import { workbenchStore, type VerificationState } from "../stores/workbench-store.js";

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
        "safari-ios": "DevTools: Open Safari's Develop menu and select the simulator and open page.",
        "chrome-android": "DevTools: Open chrome://inspect/#devices in Chrome on your machine.",
      };
      return (
        (this.debugTarget ? notes[this.debugTarget.browser] : undefined) ??
        "You can open DevTools as usual directly in the desktop browser."
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
    statusIcon(status: CheckStatus): string {
      return { ready: "fa-check", action: "fa-triangle-exclamation", blocked: "fa-xmark", skip: "fa-minus" }[status];
    },
    availability(target: WorkbenchTestTarget): string {
      if (target.busy) return "Busy";
      const remote = this.workbench?.connection.mode === "remote";
      return {
        ready: remote ? "Ready on remote machine" : "Ready on this machine",
        action: "Setup required",
        blocked: "Not available yet",
        skip: remote ? "Not available on remote operating system" : "Not available on this operating system",
      }[target.status];
    },
    verification(target: WorkbenchTestTarget): VerificationState | undefined {
      return this.store.state.verification[target.id];
    },
    verificationMessage(target: WorkbenchTestTarget): string {
      const current = this.verification(target);
      if (current) return current.message;
      return target.verifiedAt
        ? `Last successfully tested: ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(target.verifiedAt))}`
        : "";
    },
    verificationIcon(target: WorkbenchTestTarget): string {
      const status = this.verification(target)?.status;
      return status === "running" ? "fa-spinner fa-spin" : status === "failed" ? "fa-circle-xmark" : "fa-circle-check";
    },
    progress(target: WorkbenchTestTarget): string {
      if (target.browser === "safari-ios")
        return "Test running. On first launch, Xcode may take a few minutes to check the iOS runtime.";
      if (target.browser === "chrome-android")
        return target.deviceKind === "physical"
          ? "Test running on the connected Android device. The first Appium session can take a moment."
          : "Test running. On first launch, the Android Emulator may take a few minutes to start.";
      return "Test running.";
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
          message: `Test passed (${result.durationMs} ms).`,
        };
        return result;
      } catch (error) {
        this.store.state.verification[target.id] = {
          status: "failed",
          message: `Test failed: ${this.store.message(error)}`,
        };
        throw error;
      }
    },
    async verifyTarget(target: WorkbenchTestTarget): Promise<void> {
      this.store.state.busy = true;
      try {
        const result = await this.runVerification(target);
        delete this.store.state.verification[target.id];
        this.store.setNotice(`${target.label} was tested successfully (${result.durationMs} ms).`, "success");
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
            ? `${this.readyTargets.length - failures.length} of ${this.readyTargets.length} tests passed; ${failures.length} failed.`
            : `All ${this.readyTargets.length} tests completed successfully.`,
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
