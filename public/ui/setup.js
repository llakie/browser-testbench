const elements = {
  hostBadge: document.querySelector("#host-badge"),
  checks: document.querySelector("#checks"),
  actions: document.querySelector("#guided-actions"),
  actionSummary: document.querySelector("#setup-summary"),
  actionList: document.querySelector("#setup-action-list"),
  notice: document.querySelector("#notice"),
  testTargetList: document.querySelector("#test-target-list"),
  verifyAllTargets: document.querySelector("#verify-all-targets"),
  mcpClient: document.querySelector("#mcp-client"),
  debugUrl: document.querySelector("#debug-url"),
  debugTarget: document.querySelector("#debug-target"),
  remoteDiscovery: document.querySelector("#remote-discovery"),
  remoteSummary: document.querySelector("#remote-connection-summary"),
  remoteManual: document.querySelector("#remote-manual"),
  remoteServerUrl: document.querySelector("#remote-server-url"),
  remoteAdmin: document.querySelector("#remote-admin"),
  pairingForm: document.querySelector("#pairing-form"),
  pairingCode: document.querySelector("#pairing-code"),
  pairingRequests: document.querySelector("#pairing-requests"),
  remoteClients: document.querySelector("#remote-clients"),
  remoteClientList: document.querySelector("#remote-client-list"),
};

const defaultApplicationUrl = "http://127.0.0.1:3000";
const environmentRefreshDelayMs = 250;

let state;
const authorizationStorageKey = "browser-testbench-token";
let authorization = sessionStorage.getItem(authorizationStorageKey) ?? "";
const verificationStates = new Map();
let interfaceBusy = false;
let environmentRefreshTimer;
let pendingPairingId;

class WorkbenchUi {
  static async initialize() {
    document
      .querySelector("#refresh-environment")
      ?.addEventListener("click", (event) => this.refresh(event.currentTarget));
    document
      .querySelector("#register-mcp")
      ?.addEventListener("click", (event) => this.registerMcp(event.currentTarget));
    elements.verifyAllTargets?.addEventListener("click", () => this.verifyAllTargets());
    elements.mcpClient?.addEventListener("change", () => this.renderMcp());
    elements.debugUrl?.addEventListener("input", () => this.renderDebugCommand());
    elements.debugTarget?.addEventListener("change", () => this.renderDebugCommand());
    document
      .querySelector("#discover-remotes")
      ?.addEventListener("click", (event) => this.discoverRemotes(event.currentTarget));
    elements.remoteManual?.addEventListener("submit", (event) => this.connectManual(event));
    elements.pairingForm?.addEventListener("submit", (event) => this.completePairing(event));
    void window.EnvironmentEventStream.listen({
      authorization: () => authorization,
      onEnvironmentChanged: () => this.scheduleEnvironmentRefresh(),
    });
    await this.refresh();
  }

  static async refresh(trigger, { background = false } = {}) {
    const restoreTrigger = this.buttonProgress(trigger, "Checking \u2026");
    if (!background) this.busy(true);
    try {
      state = await this.request("/v1/workbench");
      elements.hostBadge?.replaceChildren(
        this.icon(this.platformIcon(state.platform)),
        document.createTextNode(`${state.platformLabel} · ${state.architecture}`),
      );
      const expandedChecks = new Set(
        [...(elements.checks?.querySelectorAll(".check-card[data-check-id] .device-options[open]") ?? [])].map(
          (details) => details.closest(".check-card").dataset.checkId,
        ),
      );
      elements.checks?.replaceChildren(...state.checks.map((check) => this.checkCard(check)));
      for (const checkId of expandedChecks) {
        const details = [...(elements.checks?.querySelectorAll(".check-card .device-options") ?? [])].find(
          (candidate) => candidate.closest(".check-card").dataset.checkId === checkId,
        );
        if (details) details.open = true;
      }
      this.renderActions();
      this.renderTestTargets();
      this.renderConnections();
      this.renderRemoteConnection();
    } catch (error) {
      if (!background) this.notice(this.message(error), "error");
    } finally {
      restoreTrigger();
      if (!background) this.busy(false);
    }
  }

  static scheduleEnvironmentRefresh() {
    clearTimeout(environmentRefreshTimer);
    environmentRefreshTimer = setTimeout(() => {
      if (interfaceBusy) {
        this.scheduleEnvironmentRefresh();
        return;
      }
      void this.refresh(undefined, { background: true });
    }, environmentRefreshDelayMs);
  }

  static checkCard(check) {
    const deviceClass = check.id === "safari-ios" || check.id === "chrome-android" ? " check-card--device" : "";
    const card = this.element("article", `check-card${deviceClass} is-${check.status}`);
    card.dataset.checkId = check.id;
    const title = this.element("div", "check-card__title");
    const status = this.element("span", "status-icon");
    status.append(this.icon(this.statusIcon(check.status)));
    title.append(document.createTextNode(check.label), status);
    const detail = this.element("p", "check-card__detail");
    detail.textContent = check.detail;
    detail.title = check.detail;
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
        status.textContent = device.compatible ? "Ready" : "Needs attention";
        heading.append(name, status);
        const meta = this.element("small");
        meta.textContent = [
          this.deviceKind(device.deviceKind),
          device.platformVersion ? `Version ${device.platformVersion}` : "",
          this.deviceState(device.state),
        ]
          .filter(Boolean)
          .join(" · ");
        item.append(heading, meta);
        if (device.detail) {
          const detail = this.element("small", "device-option__detail");
          detail.textContent = device.detail;
          item.append(detail);
        }
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
        const label = this.element("strong");
        label.textContent = action.label;
        const isInstallable =
          action.automatic && action.status === "planned" && action.targets?.length && state.permissions.configure;
        const status = this.element(
          isInstallable ? "button" : "span",
          `${isInstallable ? "button button--secondary " : ""}setup-action__status is-${action.status}`,
        );
        if (isInstallable) {
          status.type = "button";
          status.addEventListener("click", () => this.setup(action.targets, status));
        }
        status.append(
          this.icon(isInstallable ? "fa-download" : this.actionStatusIcon(action.status)),
          document.createTextNode(` ${isInstallable ? "Install" : this.actionStatus(action.status)}`),
        );
        const detail = this.element("small");
        detail.textContent =
          !state.permissions.configure && action.status !== "completed"
            ? "Administrative setup requires an admin pairing."
            : (action.detail ?? "This step must be completed manually.");
        copy.append(label, detail);
        item.append(copy, status);
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

  static renderRemoteConnection() {
    if (!elements.remoteSummary) return;
    const connection = state.connection ?? { mode: "local" };
    if (connection.mode === "remote") {
      elements.remoteSummary.textContent = `Connected to ${connection.remote.instanceName} with ${connection.remote.role} access.`;
      elements.remoteManual.hidden = true;
      document.querySelector("#discover-remotes").hidden = true;
    } else if (state.remoteMode) {
      elements.remoteSummary.textContent =
        "Remote access is enabled. Pairing requests appear below and in this terminal.";
      elements.remoteManual.hidden = true;
      document.querySelector("#discover-remotes").hidden = true;
    } else {
      elements.remoteSummary.textContent = "Use browsers and devices provided by another computer on your network.";
      elements.remoteManual.hidden = false;
      document.querySelector("#discover-remotes").hidden = false;
    }
    const requests = state.pairingRequests ?? [];
    elements.pairingRequests.hidden = requests.length === 0;
    elements.pairingRequests.replaceChildren(...requests.map((request) => this.pairingRequest(request)));
    const clients = state.authorizedClients ?? [];
    elements.remoteClients.hidden = clients.length === 0;
    elements.remoteClientList.replaceChildren(...clients.map((client) => this.remoteClient(client)));
  }

  static pairingRequest(request) {
    const item = this.element("article", "remote-instance");
    const copy = this.element("div");
    const title = this.element("strong");
    title.textContent = `${request.role === "admin" ? "Administrative" : "Control"} pairing`;
    const detail = this.element("small");
    detail.textContent = `Code ${request.code} · expires ${new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(new Date(request.expiresAt))}`;
    copy.append(title, detail);
    item.append(copy);
    return item;
  }

  static remoteClient(client) {
    const item = this.element("article", "remote-instance");
    const copy = this.element("div");
    const title = this.element("strong");
    title.textContent = client.name;
    const detail = this.element("small");
    detail.textContent = `${client.role} · last used ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(client.lastUsedAt))}`;
    const actions = this.element("div", "remote-client-actions");
    const role = this.element("button", "button button--secondary");
    role.type = "button";
    role.textContent = client.role === "admin" ? "Set control" : "Make admin";
    role.addEventListener("click", () =>
      this.setRemoteClientRole(client, client.role === "admin" ? "control" : "admin", role),
    );
    const revoke = this.element("button", "button button--secondary");
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => this.revokeRemoteClient(client, revoke));
    copy.append(title, detail);
    actions.append(role, revoke);
    item.append(copy, actions);
    return item;
  }

  static async setRemoteClientRole(client, role, trigger) {
    const restore = this.buttonProgress(trigger, "Updating …");
    try {
      await this.request(`/v1/remote/clients/${encodeURIComponent(client.clientId)}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
      await this.refresh();
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      restore();
    }
  }

  static async revokeRemoteClient(client, trigger) {
    if (!window.confirm(`Revoke access for ${client.name}?`)) return;
    const restore = this.buttonProgress(trigger, "Revoking …");
    try {
      await this.request(`/v1/remote/clients/${encodeURIComponent(client.clientId)}`, { method: "DELETE" });
      await this.refresh();
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      restore();
    }
  }

  static async discoverRemotes(trigger) {
    const restore = this.buttonProgress(trigger, "Searching …");
    try {
      const instances = await this.request("/v1/connections/discover");
      elements.remoteDiscovery.hidden = false;
      elements.remoteDiscovery.replaceChildren(
        ...(instances.length
          ? instances.map((instance) => this.remoteInstance(instance))
          : [
              Object.assign(this.element("p"), {
                textContent:
                  "No central Testbench was found. Check that remote mode is running on the same LAN and that multicast UDP 5353 and Node.js private-network access are allowed, or enter its URL below.",
              }),
            ]),
      );
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      restore();
    }
  }

  static remoteInstance(instance) {
    const item = this.element("article", "remote-instance");
    const copy = this.element("div");
    const title = this.element("strong");
    title.textContent = instance.name;
    const detail = this.element("small");
    detail.textContent = `${instance.platform}/${instance.architecture} · ${instance.authentication} · ${instance.url}`;
    const connect = this.element("button", "button button--secondary");
    connect.type = "button";
    connect.textContent = "Connect";
    connect.addEventListener("click", () => this.connectRemote(instance, connect));
    copy.append(title, detail);
    item.append(copy, connect);
    return item;
  }

  static async connectManual(event) {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    const restore = this.buttonProgress(submit, "Connecting …");
    try {
      const instance = await this.request(
        `/v1/connections/identity?server=${encodeURIComponent(elements.remoteServerUrl.value)}`,
      );
      await this.connectRemote(instance);
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      restore();
    }
  }

  static async connectRemote(instance, trigger) {
    const restore = this.buttonProgress(trigger, "Connecting …");
    try {
      const result = await this.request("/v1/connections/connect", {
        method: "POST",
        body: JSON.stringify({ instance, role: elements.remoteAdmin.checked ? "admin" : "control" }),
      });
      if (result.pairingRequired) {
        pendingPairingId = result.pairingId;
        elements.pairingForm.hidden = false;
        elements.pairingCode.focus();
        this.notice("Enter the pairing code shown on the remote computer.");
        return;
      }
      window.location.reload();
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      restore();
    }
  }

  static async completePairing(event) {
    event.preventDefault();
    if (!pendingPairingId) return;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    const restore = this.buttonProgress(submit, "Pairing …");
    try {
      await this.request("/v1/connections/pair", {
        method: "POST",
        body: JSON.stringify({ pairingId: pendingPairingId, code: elements.pairingCode.value }),
      });
      elements.pairingCode.value = "";
      window.location.reload();
    } catch (error) {
      elements.pairingCode.value = "";
      this.notice(this.message(error), "error");
    } finally {
      restore();
    }
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
          document.createTextNode(` ${target.busy ? "Busy" : this.targetAvailability(target.status)}`),
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
          verify.disabled = interfaceBusy || target.busy || verificationState?.status === "running";
          verify.append(
            this.icon(verificationState?.status === "running" ? "fa-spinner fa-spin" : "fa-circle-play"),
            document.createTextNode(verificationState?.status === "running" ? " Test running …" : " Run test"),
          );
          if (verificationState?.status === "running") verify.setAttribute("aria-busy", "true");
          verify.addEventListener("click", () => this.verifyTarget(target, verify));
          actions.append(verify);
        }
        item.append(content, actions);
        return item;
      }),
    );
  }

  static async verifyTarget(target, trigger) {
    trigger?.setAttribute("aria-busy", "true");
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
    if (progress) elements.verifyAllTargets.setAttribute("aria-busy", "true");
    else elements.verifyAllTargets.removeAttribute("aria-busy");
    elements.verifyAllTargets.replaceChildren(
      this.icon(progress ? "fa-spinner fa-spin" : "fa-list-check"),
      document.createTextNode(progress ? ` ${progress}` : " Run all tests"),
    );
  }

  static async setup(targets, trigger) {
    targets ??= state.targets.filter((target) => target.check?.status !== "skip").map((target) => target.name);
    const restoreTrigger = this.buttonProgress(trigger, "Installing \u2026");
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
      restoreTrigger();
      this.busy(false);
    }
  }

  static async registerMcp(trigger) {
    const selected = elements.mcpClient.value;
    const client = state.mcpClients.find((candidate) => candidate.id === selected);
    const restoreTrigger = this.buttonProgress(trigger, "Connecting \u2026");
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
      restoreTrigger();
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
        window.dispatchEvent(new Event("browser-testbench:authorization-changed"));
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
    if (!value && state) this.renderTestTargets();
  }

  static buttonProgress(button, label) {
    if (!button) return () => {};
    const content = [...button.childNodes];
    button.setAttribute("aria-busy", "true");
    button.replaceChildren(this.icon("fa-spinner fa-spin"), document.createTextNode(` ${label}`));
    return () => {
      if (!button.isConnected) return;
      button.removeAttribute("aria-busy");
      button.replaceChildren(...content);
    };
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
    return (
      { completed: "Installed", planned: "Not installed", manual: "Action required", failed: "Failed" }[status] ??
      status
    );
  }

  static actionStatusIcon(status) {
    return (
      {
        completed: "fa-check",
        planned: "fa-clock",
        manual: "fa-triangle-exclamation",
        failed: "fa-xmark",
      }[status] ?? "fa-circle"
    );
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
      if (target.deviceKind === "physical") {
        return "Test running on the connected Android device. The first Appium session can take a moment.";
      }
      return "Test running. On first launch, the Android Emulator may take a few minutes to start.";
    }
    return "Test running.";
  }

  static platformIcon(platform) {
    return platform === "darwin" ? "fa-laptop" : platform === "win32" ? "fa-desktop" : "fa-terminal";
  }

  static deviceState(state) {
    return (
      {
        Booted: "Running",
        Shutdown: "Shut down",
        Creating: "Creating",
        Connected: "Connected via USB",
        unauthorized: "USB debugging authorization required",
        offline: "Device offline",
        "no permissions": "USB permission required",
        Available: "Available",
      }[state] ??
      state ??
      ""
    );
  }

  static deviceKind(kind) {
    return { physical: "Physical device", emulator: "Emulator", simulator: "Simulator" }[kind] ?? "";
  }
}

void WorkbenchUi.initialize();
