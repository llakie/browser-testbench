const elements = {
  hostBadge: document.querySelector("#host-badge"),
  checks: document.querySelector("#checks"),
  actions: document.querySelector("#guided-actions"),
  actionSummary: document.querySelector("#setup-summary"),
  actionList: document.querySelector("#setup-action-list"),
  runSetup: document.querySelector("#run-setup"),
  notice: document.querySelector("#notice"),
  testTargetList: document.querySelector("#test-target-list"),
  verifyAllTargets: document.querySelector("#verify-all-targets"),
  mcpClient: document.querySelector("#mcp-client"),
  debugUrl: document.querySelector("#debug-url"),
  debugTarget: document.querySelector("#debug-target"),
};

const defaultApplicationUrl = "http://127.0.0.1:3000";

let state;
const authorizationStorageKey = "browser-testbench-token";
let authorization = sessionStorage.getItem(authorizationStorageKey) ?? "";
const verificationStates = new Map();
let interfaceBusy = false;

class WorkbenchUi {
  static async initialize() {
    document.querySelector("#refresh-environment")?.addEventListener("click", () => this.refresh());
    document.querySelector("#run-setup")?.addEventListener("click", () => this.setup());
    document.querySelector("#register-mcp")?.addEventListener("click", () => this.registerMcp());
    elements.verifyAllTargets?.addEventListener("click", () => this.verifyAllTargets());
    elements.mcpClient?.addEventListener("change", () => this.renderMcp());
    elements.debugUrl?.addEventListener("input", () => this.renderDebugCommand());
    elements.debugTarget?.addEventListener("change", () => this.renderDebugCommand());
    await this.refresh();
  }

  static async refresh() {
    this.busy(true);
    try {
      state = await this.request("/v1/workbench");
      elements.hostBadge?.replaceChildren(
        this.icon(this.platformIcon(state.platform)),
        document.createTextNode(`${state.platformLabel} · ${state.architecture}`),
      );
      elements.checks?.replaceChildren(...state.checks.map((check) => this.checkCard(check)));
      this.renderActions();
      this.renderTestTargets();
      this.renderConnections();
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      this.busy(false);
    }
  }

  static checkCard(check) {
    const deviceClass = check.id === "safari-ios" || check.id === "chrome-android" ? " check-card--device" : "";
    const card = this.element("article", `check-card${deviceClass} is-${check.status}`);
    const title = this.element("div", "check-card__title");
    const status = this.element("span", "status-icon");
    status.append(this.icon(this.statusIcon(check.status)));
    title.append(document.createTextNode(check.label), status);
    const detail = this.element("p");
    detail.textContent = check.detail;
    card.append(title, detail);
    if (check.action) {
      const action = this.element("p", "check-card__action");
      action.textContent = check.action;
      card.append(action);
    }
    for (const command of check.commands ?? []) card.append(this.command(command));
    if (check.devices?.length) card.append(this.deviceOptions(check.devices));
    return card;
  }

  static deviceOptions(devices) {
    const details = this.element("details", "device-options");
    const summary = this.element("summary");
    summary.append(
      this.icon("fa-mobile-screen-button"),
      ` Show ${devices.length} ${devices.length === 1 ? "device" : "devices"}`,
    );
    const list = this.element("div", "device-options__list");
    list.append(
      ...devices.map((device) => {
        const item = this.element("article", `device-option${device.compatible ? "" : " is-incompatible"}`);
        const heading = this.element("div", "device-option__heading");
        const name = this.element("strong");
        name.textContent = device.name;
        const status = this.element("span");
        status.textContent = device.compatible ? "Ready" : "Not Chrome-compatible";
        heading.append(name, status);
        const meta = this.element("small");
        meta.textContent = [
          device.platformVersion ? `Version ${device.platformVersion}` : "",
          this.deviceState(device.state),
        ]
          .filter(Boolean)
          .join(" · ");
        item.append(heading, meta);
        if (device.compatible) item.append(this.command(JSON.stringify(device.config)));
        return item;
      }),
    );
    details.append(summary, list);
    return details;
  }

  static renderActions() {
    if (!elements.actions) return;
    const actions = state.actions ?? [];
    elements.actions.hidden = actions.length === 0;
    elements.runSetup.hidden = !actions.some((action) => action.automatic && action.status === "planned");
    if (actions.length === 0) return;
    const completed = actions.filter((action) => action.status === "completed").length;
    const pending = actions.length - completed;
    elements.actionSummary.textContent = pending
      ? `${completed} installed · ${pending} ${pending === 1 ? "step" : "steps"} remaining`
      : "All required extensions are installed.";
    elements.actionList.replaceChildren(
      ...actions.map((action) => {
        const item = this.element("div", "setup-action");
        const copy = this.element("div", "setup-action__copy");
        const heading = this.element("span", "setup-action__heading");
        const label = this.element("strong");
        label.textContent = action.label;
        const status = this.element("span", `setup-action__status is-${action.status}`);
        status.append(
          this.icon(action.status === "completed" ? "fa-check" : "fa-arrow-right"),
          document.createTextNode(` ${this.actionStatus(action.status)}`),
        );
        heading.append(label, status);
        const detail = this.element("small");
        detail.textContent = action.detail ?? "This step must be completed manually.";
        copy.append(heading, detail);
        item.append(copy);
        if (action.command) item.append(this.command(action.command));
        return item;
      }),
    );
  }

  static renderConnections() {
    if (elements.mcpClient) {
      const previous = elements.mcpClient.value;
      elements.mcpClient.replaceChildren(
        ...state.mcpClients.map((client) => {
          const option = document.createElement("option");
          option.value = client.id;
          option.textContent = client.label;
          return option;
        }),
      );
      const preferred =
        state.mcpClients.find((client) => client.id === previous) ??
        state.mcpClients.find((client) => client.current) ??
        state.mcpClients.find((client) => client.installed && client.automatic) ??
        state.mcpClients[0];
      elements.mcpClient.value = preferred.id;
      this.renderMcp();
    }
    const installCommand = document.querySelector("#project-install-command");
    if (!installCommand) return;
    installCommand.replaceChildren(this.command(state.clientInstallCommand));
    const readyTargets = state.testTargets.filter((target) => target.ready);
    const desktop = readyTargets.find((target) => target.kind === "desktop");
    const mobile = readyTargets.find((target) => target.kind === "mobile");
    const requested = [...new Set([desktop?.id, mobile?.id].filter(Boolean))];
    const examples = requested.length ? requested : ["chrome"];
    const example = `import { RemoteTestbench } from "${state.packageName}/client";

const testbench = new RemoteTestbench();
const targets = await testbench.availableTargets(${JSON.stringify(examples, null, 2)});

for (const target of targets) {
  const browser = await testbench.open({ target, url: "${defaultApplicationUrl}", headless: true });

  try {
    await browser.click('button[type="submit"]');
    await browser.waitForText("Welcome");
    await browser.screenshot(\`artifacts/login-\${target}.png\`);
  } finally {
    await browser.close();
  }
}`;
    document.querySelector("#project-client-example").replaceChildren(this.command(example, true));
    this.renderDebugTargets();
  }

  static renderDebugTargets() {
    if (!elements.debugTarget) return;
    const previous = elements.debugTarget.value;
    const options = state.testTargets;
    elements.debugTarget.replaceChildren(
      ...options.map((target) => {
        const option = document.createElement("option");
        option.value = target.id;
        option.textContent = `${target.label}${target.ready ? "" : " · Setup required"}`;
        return option;
      }),
    );
    const preferred =
      options.find((target) => target.id === previous) ?? options.find((target) => target.ready) ?? options[0];
    if (preferred) elements.debugTarget.value = preferred.id;
    this.renderDebugCommand();
  }

  static renderDebugCommand() {
    if (!elements.debugTarget?.value || !elements.debugUrl) return;
    const target = state.testTargets.find((candidate) => candidate.id === elements.debugTarget.value);
    if (!target) return;
    const url = elements.debugUrl.value.trim() || defaultApplicationUrl;
    const argumentsList = ["npx", state.packageName, "open", "--target", target.id, "--url", url];
    document.querySelector("#debug-open-command").replaceChildren(this.command(this.shellCommand(argumentsList)));

    const notes = {
      "safari-ios": "DevTools: Open Safari's Develop menu and select the simulator and open page.",
      "chrome-android": "DevTools: Open chrome://inspect/#devices in Chrome on your machine.",
    };
    document.querySelector("#debug-tools-note").textContent =
      notes[target.browser] ?? "You can open DevTools as usual directly in the desktop browser.";
  }

  static shellCommand(parts) {
    return parts.map((part) => (/\s|"/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)).join(" ");
  }

  static renderMcp() {
    if (!elements.mcpClient) return;
    const client = state.mcpClients.find((candidate) => candidate.id === elements.mcpClient.value);
    const mcpStatus = document.querySelector("#mcp-status");
    const register = document.querySelector("#register-mcp");
    mcpStatus.textContent = client.detail;
    mcpStatus.className = `integration-status ${client.current ? "is-ready" : client.installed ? "is-action" : "is-blocked"}`;
    document.querySelector("#mcp-instruction").textContent = client.instruction;
    register.hidden = !client.automatic || client.current || !client.installed;
    document.querySelector("#mcp-command").replaceChildren(this.command(client.command, client.format === "json"));
  }

  static renderTestTargets() {
    if (!elements.testTargetList || !elements.verifyAllTargets) return;
    const readyTargets = state.testTargets.filter((target) => target.ready);
    elements.verifyAllTargets.hidden = readyTargets.length === 0;
    elements.verifyAllTargets.disabled = interfaceBusy;
    elements.testTargetList.replaceChildren(
      ...state.testTargets.map((target) => {
        const verificationState = verificationStates.get(target.id);
        const item = this.element("article", `test-target is-${target.status}`);
        const content = this.element("div", "test-target__content");
        const heading = this.element("div", "test-target__heading");
        const name = this.element("strong");
        name.textContent = target.label;
        const status = this.element("span", `test-target__status is-${target.status}`);
        status.append(
          this.icon(this.statusIcon(target.status)),
          document.createTextNode(` ${this.targetAvailability(target.status)}`),
        );
        heading.append(name, status);
        const detail = this.element("small");
        detail.textContent = target.detail;
        content.append(heading, detail);
        if (verificationState || target.verifiedAt) {
          const verification = this.element(
            "small",
            `test-target__verification${verificationState ? ` is-${verificationState.status}` : " is-passed"}`,
          );
          const message = verificationState
            ? verificationState.message
            : `Last successfully tested: ${new Intl.DateTimeFormat("en", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(target.verifiedAt))}`;
          verification.append(
            this.icon(
              verificationState?.status === "running"
                ? "fa-spinner fa-spin"
                : verificationState?.status === "failed"
                  ? "fa-circle-xmark"
                  : "fa-circle-check",
            ),
            document.createTextNode(` ${message}`),
          );
          content.append(verification);
        }
        const actions = this.element("div", "test-target__actions");
        actions.append(this.command(target.id, false, "Target ID"));
        if (target.ready) {
          const verify = this.element("button", "button button--secondary");
          verify.type = "button";
          verify.disabled = interfaceBusy || verificationState?.status === "running";
          verify.append(
            this.icon(verificationState?.status === "running" ? "fa-spinner fa-spin" : "fa-circle-play"),
            document.createTextNode(verificationState?.status === "running" ? " Test running …" : " Run test"),
          );
          verify.addEventListener("click", () => this.verifyTarget(target));
          actions.append(verify);
        }
        item.append(content, actions);
        return item;
      }),
    );
  }

  static async verifyTarget(target) {
    this.busy(true);
    try {
      const result = await this.runVerification(target);
      verificationStates.delete(target.id);
      this.notice(`${target.label} was tested successfully (${result.durationMs} ms).`, "success");
      await this.refresh();
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      this.busy(false);
    }
  }

  static async verifyAllTargets() {
    const targets = state.testTargets.filter((target) => target.ready);
    if (targets.length === 0) return;

    const failures = [];
    this.busy(true);
    try {
      for (const [index, target] of targets.entries()) {
        this.verifyAllLabel(`Checking ${index + 1} of ${targets.length}`);
        try {
          await this.runVerification(target);
        } catch (error) {
          failures.push({ target, error });
        }
      }
      for (const target of targets) {
        if (verificationStates.get(target.id)?.status === "passed") verificationStates.delete(target.id);
      }
      await this.refresh();
      this.notice(
        failures.length
          ? `${targets.length - failures.length} of ${targets.length} tests passed; ${failures.length} failed.`
          : `All ${targets.length} tests completed successfully.`,
        failures.length ? "error" : "success",
      );
    } finally {
      this.verifyAllLabel();
      this.busy(false);
    }
  }

  static async runVerification(target) {
    verificationStates.set(target.id, {
      status: "running",
      message: this.verificationProgress(target),
    });
    this.renderTestTargets();
    try {
      const result = await this.request("/v1/verify", {
        method: "POST",
        body: JSON.stringify({
          target: target.id,
          ...(target.kind === "desktop" && target.browser !== "safari" ? { headless: true } : {}),
        }),
      });
      verificationStates.set(target.id, {
        status: "passed",
        message: `Test passed (${result.durationMs} ms).`,
      });
      this.renderTestTargets();
      return result;
    } catch (error) {
      const message = this.message(error);
      verificationStates.set(target.id, { status: "failed", message: `Test failed: ${message}` });
      this.renderTestTargets();
      throw error;
    }
  }

  static verifyAllLabel(progress) {
    if (!elements.verifyAllTargets) return;
    elements.verifyAllTargets.replaceChildren(
      this.icon(progress ? "fa-spinner fa-spin" : "fa-list-check"),
      document.createTextNode(progress ? ` ${progress}` : " Run all tests"),
    );
  }

  static async setup() {
    const targets = state.targets.filter((target) => target.check?.status !== "skip").map((target) => target.name);
    this.busy(true);
    try {
      const actions = await this.request("/v1/workbench/setup", {
        method: "POST",
        body: JSON.stringify({
          targets,
        }),
      });
      const failures = actions.filter((action) => action.status === "failed");
      this.notice(
        failures.length
          ? failures.length === 1
            ? "One setup step failed."
            : `${failures.length} setup steps failed.`
          : "Setup completed.",
        failures.length ? "error" : "success",
      );
      await this.refresh();
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      this.busy(false);
    }
  }

  static async registerMcp() {
    const selected = elements.mcpClient.value;
    const client = state.mcpClients.find((candidate) => candidate.id === selected);
    this.busy(true);
    try {
      const updated = await this.request("/v1/workbench/mcp", {
        method: "POST",
        body: JSON.stringify({ client: selected }),
      });
      state.mcpClients = state.mcpClients.map((candidate) => (candidate.id === selected ? updated : candidate));
      this.renderMcp();
      this.notice(`${client.label} is connected to Browser Testbench.`, "success");
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      this.busy(false);
    }
  }

  static command(value, multiline = false, copyLabel = "Command") {
    const container = this.element("div", `command-block${multiline ? " command-block--multiline" : ""}`);
    const code = this.element("code");
    code.textContent = value;
    const button = this.element("button", "copy-command");
    button.type = "button";
    const accessibleLabel = copyLabel === "Target ID" ? "Copy target ID" : "Copy command";
    button.title = accessibleLabel;
    button.setAttribute("aria-label", accessibleLabel);
    button.append(this.icon("fa-copy"));
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(value);
      button.replaceChildren(this.icon("fa-check"));
    });
    container.append(code, button);
    return container;
  }

  static async request(path, options = {}, retry = true) {
    const headers = { ...(options.body ? { "content-type": "application/json" } : {}) };
    if (authorization) headers.authorization = `Bearer ${authorization}`;
    const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
    if (response.status === 401 && retry) {
      const token = window.prompt("Browser Testbench bearer token:");
      if (token) {
        authorization = token;
        sessionStorage.setItem(authorizationStorageKey, token);
        return this.request(path, options, false);
      }
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  static busy(value) {
    interfaceBusy = value;
    document.querySelectorAll(".page-content button, .page-content input, .page-content select").forEach((control) => {
      control.disabled = value;
    });
  }

  static notice(message, kind = "") {
    elements.notice.hidden = false;
    elements.notice.className = `notice${kind ? ` is-${kind}` : ""}`;
    elements.notice.textContent = message;
  }

  static message(error) {
    return error instanceof Error ? error.message : String(error);
  }

  static element(tag, className = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  static icon(classes) {
    const icon = this.element("i", `fa-solid ${classes}`);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  static statusIcon(status) {
    return (
      { ready: "fa-check", action: "fa-triangle-exclamation", blocked: "fa-xmark", skip: "fa-minus" }[status] ??
      "fa-circle"
    );
  }

  static actionStatus(status) {
    return { completed: "Installed", planned: "Ready", manual: "Manual", failed: "Failed" }[status] ?? status;
  }

  static targetAvailability(status) {
    return {
      ready: "Ready on this machine",
      action: "Setup required",
      blocked: "Not available yet",
      skip: "Not available on this operating system",
    }[status];
  }

  static verificationProgress(target) {
    if (target.browser === "safari-ios") {
      return "Test running. On first launch, Xcode may take a few minutes to check the iOS runtime.";
    }
    if (target.browser === "chrome-android") {
      return "Test running. On first launch, the Android Emulator may take a few minutes to start.";
    }
    return "Test running.";
  }

  static platformIcon(platform) {
    return platform === "darwin" ? "fa-laptop" : platform === "win32" ? "fa-desktop" : "fa-terminal";
  }

  static deviceState(state) {
    return { Booted: "Running", Shutdown: "Shut down", Creating: "Creating" }[state] ?? state ?? "";
  }
}

void WorkbenchUi.initialize();
