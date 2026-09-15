const elements = {
  hostBadge: document.querySelector("#host-badge"),
  checks: document.querySelector("#checks"),
  actions: document.querySelector("#guided-actions"),
  actionSummary: document.querySelector("#setup-summary"),
  actionList: document.querySelector("#setup-action-list"),
  runSetup: document.querySelector("#run-setup"),
  notice: document.querySelector("#notice"),
  configForm: document.querySelector("#config-form"),
  configTargets: document.querySelector("#config-target-list"),
  configPreview: document.querySelector("#config-preview"),
  configMessage: document.querySelector("#config-message"),
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
    elements.configForm.addEventListener("input", () => this.renderConfig());
    elements.configForm.addEventListener("change", () => this.renderConfig());
    document.querySelector("#copy-config").addEventListener("click", () => this.copyConfig());
    document.querySelector("#download-config").addEventListener("click", () => this.downloadConfig());
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
      this.renderConnections();
      this.renderConfigTargets();
      this.renderConfig();
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
    const example = `import { RemoteTestbench } from "browser-testbench/client";
import config from "./testbench.config.json" with { type: "json" };

const testbench = new RemoteTestbench(config);
const browser = await testbench.open({ target: "chrome", url: "http://127.0.0.1:3000" });

try {
  await browser.click("button=Anmelden");
  await browser.waitForText("Willkommen");
  await browser.screenshot("artifacts/anmeldung.png");
} finally {
  await browser.close();
}`;
    document.querySelector("#project-client-example").replaceChildren(this.command(example, true));
    this.renderDebugTargets();
  }

  static renderDebugTargets() {
    const previous = elements.debugTarget.value;
    const targets = state.targets.filter((target) => target.check?.status !== "skip");
    const options = targets.flatMap((target) => {
      const devices = (target.check?.devices ?? []).filter((device) => device.compatible);
      if (target.kind === "mobile" && devices.length) {
        return devices.map((device) => ({
          config: device.config,
          label: `${target.label} · ${device.name}${device.platformVersion ? ` · ${device.platformVersion}` : ""}`,
        }));
      }
      return [
        {
          config: { name: target.name },
          label: `${target.label}${target.check?.status === "ready" ? "" : " · Einrichtung erforderlich"}`,
        },
      ];
    });
    elements.debugTarget.replaceChildren(
      ...options.map(({ config, label }) => {
        const option = document.createElement("option");
        option.value = JSON.stringify(config);
        option.textContent = label;
        return option;
      }),
    );
    const preferred = options.find(({ config }) => JSON.stringify(config) === previous) ?? options[0];
    if (preferred) elements.debugTarget.value = JSON.stringify(preferred.config);
    this.renderDebugCommand();
  }

  static renderDebugCommand() {
    if (!elements.debugTarget.value) return;
    const target = JSON.parse(elements.debugTarget.value);
    const url = elements.debugUrl.value.trim() || "http://127.0.0.1:3000";
    const argumentsList = ["npx", "browser-testbench", "open", "--target", target.name, "--url", url];
    if (target.deviceName) argumentsList.push("--device-name", target.deviceName);
    if (target.platformVersion) argumentsList.push("--platform-version", target.platformVersion);
    if (target.avd) argumentsList.push("--avd", target.avd);
    if (target.udid) argumentsList.push("--udid", target.udid);
    document.querySelector("#debug-open-command").replaceChildren(this.command(this.shellCommand(argumentsList)));

    const notes = {
      "safari-ios":
        "DevTools: Öffne in Safari das Menü „Entwickeln“ und wähle dort den Simulator und die geöffnete Seite aus.",
      "chrome-android": "DevTools: Öffne chrome://inspect/#devices in Chrome auf deinem Rechner.",
    };
    document.querySelector("#debug-tools-note").textContent =
      notes[target.name] ?? "DevTools kannst du wie gewohnt direkt im geöffneten Desktopbrowser aufrufen.";
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

  static renderConfigTargets() {
    elements.configTargets.replaceChildren(
      ...state.targets.map((target) => {
        const option = this.element("div", "config-target");
        const label = this.element("label", "config-target__choice");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = "configTarget";
        checkbox.value = target.name;
        checkbox.checked = target.check?.status === "ready";
        const copy = this.element("span");
        const name = this.element("strong");
        name.textContent = target.label;
        const availability = this.element("small", `is-${target.check?.status ?? "blocked"}`);
        availability.textContent = this.targetAvailability(target.check?.status);
        copy.append(name, availability);
        label.append(checkbox, copy);
        option.append(label);

        const devices = (target.check?.devices ?? []).filter((device) => device.compatible);
        if (target.kind === "mobile" && devices.length > 0) {
          const deviceLabel = this.element("label", "config-target__device");
          const caption = this.element("span");
          caption.textContent = "Gerät";
          const select = document.createElement("select");
          select.name = `device-${target.name}`;
          for (const device of devices) {
            const entry = document.createElement("option");
            entry.value = JSON.stringify(device.config);
            entry.textContent = `${device.name}${device.platformVersion ? ` · ${device.platformVersion}` : ""}`;
            select.append(entry);
          }
          deviceLabel.append(caption, select);
          option.append(deviceLabel);
        }
        return option;
      }),
    );
  }

  static renderConfig() {
    const config = this.configValue();
    elements.configPreview.textContent = JSON.stringify(config, null, 2);
    elements.configMessage.textContent = config.targets.length
      ? ""
      : "Wähle mindestens ein Testziel aus, bevor du die Datei speicherst.";
  }

  static configValue() {
    const selectedTargets = [...elements.configForm.querySelectorAll('input[name="configTarget"]:checked')];
    const headless = document.querySelector("#config-headless").checked;
    const targets = selectedTargets.map((input) => {
      const target = state.targets.find((candidate) => candidate.name === input.value);
      const deviceSelect = elements.configForm.querySelector(`[name="device-${input.value}"]`);
      if (deviceSelect?.value) return JSON.parse(deviceSelect.value);
      if (headless && target?.kind === "desktop" && target.name !== "safari") {
        return { name: target.name, headless: true };
      }
      return target.name;
    });
    return {
      server: window.location.origin,
      targetPolicy: document.querySelector("#config-available").checked ? "available" : "strict",
      targets,
    };
  }

  static validConfig() {
    const config = this.configValue();
    if (!elements.configForm.reportValidity()) return;
    if (config.targets.length === 0) {
      elements.configMessage.textContent = "Wähle mindestens ein Testziel aus.";
      return;
    }
    elements.configMessage.textContent = "";
    return config;
  }

  static async copyConfig() {
    const config = this.validConfig();
    if (!config) return;
    await navigator.clipboard.writeText(`${JSON.stringify(config, null, 2)}\n`);
    elements.configMessage.textContent = "JSON wurde in die Zwischenablage kopiert.";
  }

  static downloadConfig() {
    const config = this.validConfig();
    if (!config) return;
    const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "testbench.config.json";
    link.click();
    URL.revokeObjectURL(url);
    elements.configMessage.textContent = "testbench.config.json wurde heruntergeladen.";
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

  static command(value, multiline = false) {
    const container = this.element("div", `command-block${multiline ? " command-block--multiline" : ""}`);
    const code = this.element("code");
    code.textContent = value;
    const button = this.element("button", "copy-command");
    button.type = "button";
    button.title = "Befehl kopieren";
    button.setAttribute("aria-label", "Befehl kopieren");
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
