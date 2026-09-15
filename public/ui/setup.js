const elements = {
  hostBadge: document.querySelector("#host-badge"),
  checks: document.querySelector("#checks"),
  actions: document.querySelector("#guided-actions"),
  actionSummary: document.querySelector("#setup-summary"),
  actionList: document.querySelector("#setup-action-list"),
  runSetup: document.querySelector("#run-setup"),
  notice: document.querySelector("#notice"),
  testTargetList: document.querySelector("#test-target-list"),
  mcpClient: document.querySelector("#mcp-client"),
  debugUrl: document.querySelector("#debug-url"),
  debugTarget: document.querySelector("#debug-target"),
};

let state;
let authorization = sessionStorage.getItem("browser-testbench-token") ?? "";

class WorkbenchUi {
  static async initialize() {
    document.querySelector("#refresh-environment").addEventListener("click", () => this.refresh());
    document.querySelector("#run-setup").addEventListener("click", () => this.setup());
    document.querySelector("#register-mcp").addEventListener("click", () => this.registerMcp());
    elements.mcpClient.addEventListener("change", () => this.renderMcp());
    elements.debugUrl.addEventListener("input", () => this.renderDebugCommand());
    elements.debugTarget.addEventListener("change", () => this.renderDebugCommand());
    await this.refresh();
  }

  static async refresh() {
    this.busy(true);
    try {
      state = await this.request("/v1/workbench");
      elements.hostBadge.replaceChildren(
        this.icon(this.platformIcon(state.platform)),
        document.createTextNode(`${state.platformLabel} · ${state.architecture}`),
      );
      elements.checks.replaceChildren(...state.checks.map((check) => this.checkCard(check)));
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
      ` ${devices.length} ${devices.length === 1 ? "Gerät" : "Geräte"} anzeigen`,
    );
    const list = this.element("div", "device-options__list");
    list.append(
      ...devices.map((device) => {
        const item = this.element("article", `device-option${device.compatible ? "" : " is-incompatible"}`);
        const heading = this.element("div", "device-option__heading");
        const name = this.element("strong");
        name.textContent = device.name;
        const status = this.element("span");
        status.textContent = device.compatible ? "Einsatzbereit" : "Nicht Chrome-fähig";
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
    const actions = state.actions ?? [];
    elements.actions.hidden = actions.length === 0;
    elements.runSetup.hidden = !actions.some((action) => action.automatic && action.status === "planned");
    if (actions.length === 0) return;
    const completed = actions.filter((action) => action.status === "completed").length;
    const pending = actions.length - completed;
    elements.actionSummary.textContent = pending
      ? `${completed} installiert · ${pending} ${pending === 1 ? "Schritt ist" : "Schritte sind"} noch offen`
      : "Alle benötigten Erweiterungen sind installiert.";
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
        detail.textContent = action.detail ?? "Dieser Schritt muss manuell ausgeführt werden.";
        copy.append(heading, detail);
        item.append(copy);
        if (action.command) item.append(this.command(action.command));
        return item;
      }),
    );
  }

  static renderConnections() {
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
    document.querySelector("#project-install-command").replaceChildren(this.command(state.clientInstallCommand));
    const readyTargets = state.testTargets.filter((target) => target.ready);
    const desktop = readyTargets.find((target) => target.kind === "desktop");
    const mobile = readyTargets.find((target) => target.kind === "mobile");
    const requested = [...new Set([desktop?.id, mobile?.id].filter(Boolean))];
    const examples = requested.length ? requested : ["chrome"];
    const example = `import { RemoteTestbench } from "browser-testbench/client";

const testbench = new RemoteTestbench();
const targets = await testbench.availableTargets(${JSON.stringify(examples, null, 2)});

for (const target of targets) {
  const browser = await testbench.open({ target, url: "http://127.0.0.1:3000", headless: true });

  try {
    await browser.click("button=Anmelden");
    await browser.waitForText("Willkommen");
    await browser.screenshot(\`artifacts/anmeldung-\${target}.png\`);
  } finally {
    await browser.close();
  }
}`;
    document.querySelector("#project-client-example").replaceChildren(this.command(example, true));
    this.renderDebugTargets();
  }

  static renderDebugTargets() {
    const previous = elements.debugTarget.value;
    const options = state.testTargets;
    elements.debugTarget.replaceChildren(
      ...options.map((target) => {
        const option = document.createElement("option");
        option.value = target.id;
        option.textContent = `${target.label}${target.ready ? "" : " · Einrichtung erforderlich"}`;
        return option;
      }),
    );
    const preferred =
      options.find((target) => target.id === previous) ?? options.find((target) => target.ready) ?? options[0];
    if (preferred) elements.debugTarget.value = preferred.id;
    this.renderDebugCommand();
  }

  static renderDebugCommand() {
    if (!elements.debugTarget.value) return;
    const target = state.testTargets.find((candidate) => candidate.id === elements.debugTarget.value);
    if (!target) return;
    const url = elements.debugUrl.value.trim() || "http://127.0.0.1:3000";
    const argumentsList = ["npx", "browser-testbench", "open", "--target", target.id, "--url", url];
    document.querySelector("#debug-open-command").replaceChildren(this.command(this.shellCommand(argumentsList)));

    const notes = {
      "safari-ios":
        "DevTools: Öffne in Safari das Menü „Entwickeln“ und wähle dort den Simulator und die geöffnete Seite aus.",
      "chrome-android": "DevTools: Öffne chrome://inspect/#devices in Chrome auf deinem Rechner.",
    };
    document.querySelector("#debug-tools-note").textContent =
      notes[target.browser] ?? "DevTools kannst du wie gewohnt direkt im geöffneten Desktopbrowser aufrufen.";
  }

  static shellCommand(parts) {
    return parts.map((part) => (/\s|"/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)).join(" ");
  }

  static renderMcp() {
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
    elements.testTargetList.replaceChildren(
      ...state.testTargets.map((target) => {
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
        item.append(content, this.command(target.id, false, "Ziel-ID"));
        return item;
      }),
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
          ...(targets.includes("chrome-android") ? { androidAvdName: "Browser_Testbench_API_36" } : {}),
        }),
      });
      const failures = actions.filter((action) => action.status === "failed");
      this.notice(
        failures.length
          ? failures.length === 1
            ? "Ein Einrichtungsschritt ist fehlgeschlagen."
            : `${failures.length} Einrichtungsschritte sind fehlgeschlagen.`
          : "Einrichtung abgeschlossen.",
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
      this.notice(`${client.label} ist mit der Testbench verbunden.`, "success");
    } catch (error) {
      this.notice(this.message(error), "error");
    } finally {
      this.busy(false);
    }
  }

  static command(value, multiline = false, copyLabel = "Befehl") {
    const container = this.element("div", `command-block${multiline ? " command-block--multiline" : ""}`);
    const code = this.element("code");
    code.textContent = value;
    const button = this.element("button", "copy-command");
    button.type = "button";
    button.title = `${copyLabel} kopieren`;
    button.setAttribute("aria-label", `${copyLabel} kopieren`);
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
      const token = window.prompt("Bearer-Token der Testbench:");
      if (token) {
        authorization = token;
        sessionStorage.setItem("browser-testbench-token", token);
        return this.request(path, options, false);
      }
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  static busy(value) {
    document.querySelectorAll("button, input, select").forEach((control) => {
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
    return (
      { completed: "Installiert", planned: "Bereit", manual: "Manuell", failed: "Fehlgeschlagen" }[status] ?? status
    );
  }

  static targetAvailability(status) {
    return {
      ready: "Auf diesem Rechner einsatzbereit",
      action: "Einrichtung erforderlich",
      blocked: "Noch nicht verfügbar",
      skip: "Auf diesem Betriebssystem nicht verfügbar",
    }[status];
  }

  static platformIcon(platform) {
    return platform === "darwin" ? "fa-laptop" : platform === "win32" ? "fa-desktop" : "fa-terminal";
  }

  static deviceState(state) {
    return { Booted: "Gestartet", Shutdown: "Ausgeschaltet", Creating: "Wird erstellt" }[state] ?? state ?? "";
  }
}

void WorkbenchUi.initialize();
