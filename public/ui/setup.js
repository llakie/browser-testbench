const elements = {
  form: document.querySelector("#configuration-form"),
  hostBadge: document.querySelector("#host-badge"),
  configPath: document.querySelector("#config-path"),
  checks: document.querySelector("#checks"),
  guidedActions: document.querySelector("#guided-actions"),
  setupSummary: document.querySelector("#setup-summary"),
  targetList: document.querySelector("#target-list"),
  notice: document.querySelector("#notice"),
  saveState: document.querySelector("#save-state"),
  jsonEditor: document.querySelector("#json-editor"),
  results: document.querySelector("#results"),
  resultTitle: document.querySelector("#result-title"),
  resultCopy: document.querySelector("#result-copy"),
  runStatus: document.querySelector("#run-status"),
  resultGrid: document.querySelector("#result-grid"),
};

let state;
let currentConfig;
let authorization = sessionStorage.getItem("btb-token") ?? "";

class WorkbenchUi {
  static async initialize() {
    this.bindEvents();
    await this.refresh();
  }

  static bindEvents() {
    elements.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.save();
    });
    document.querySelector("#save-and-run").addEventListener("click", async () => {
      if (!elements.form.reportValidity()) return;
      if (await this.save()) await this.run();
    });
    document.querySelector("#refresh-environment").addEventListener("click", () => this.refresh());
    document.querySelector("#run-setup").addEventListener("click", () => this.setup());
    document.querySelector("#apply-json").addEventListener("click", () => this.applyJson());
    elements.form.addEventListener("input", (event) => {
      if (event.target === elements.jsonEditor) return;
      this.markDirty();
      this.syncJsonFromForm();
    });
  }

  static async refresh() {
    this.setButtonsBusy(true);
    try {
      state = await this.request("/v1/workbench");
      currentConfig = state.config;
      elements.hostBadge.innerHTML = "";
      elements.hostBadge.append(
        this.icon(this.platformIcon(state.platform)),
        `${state.platformLabel} · ${state.architecture}`,
      );
      elements.configPath.textContent = state.configPath;
      elements.configPath.title = state.configPath;
      this.populateForm(currentConfig);
      this.renderChecks();
      this.renderTargets();
      this.renderActions();
      this.markSaved(state.configExists ? "Gespeichert" : "Noch nicht angelegt");
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.setButtonsBusy(false);
    }
  }

  static populateForm(config) {
    document.querySelector("#project-name").value = config.name ?? "";
    document.querySelector("#base-url").value = config.baseUrl ?? "";
    document.querySelector("#server-command").value = config.webServer?.command ?? "";
    document.querySelector("#server-cwd").value = config.webServer?.cwd ?? ".";
    document.querySelector("#health-url").value = config.webServer?.healthUrl ?? "";
    document.querySelector("#specs").value = (config.specs ?? []).join(", ");
    elements.jsonEditor.value = JSON.stringify(config, null, 2);
  }

  static renderChecks() {
    elements.checks.replaceChildren(...state.checks.map((check) => this.checkCard(check)));
  }

  static checkCard(check) {
    const card = this.element("article", `check-card is-${check.status}`);
    const title = this.element("div", "check-card__title");
    const icon = this.element("span", "status-icon");
    icon.append(this.icon(this.statusIcon(check.status)));
    title.append(document.createTextNode(check.label), icon);
    const detail = this.element("p");
    detail.textContent = check.detail;
    card.append(title, detail);
    if (check.action) {
      const action = this.element("p");
      action.textContent = check.action;
      action.style.marginTop = "0.5rem";
      card.append(action);
    }
    return card;
  }

  static renderTargets() {
    const selected = new Set(
      (currentConfig.targets ?? []).map((target) => (typeof target === "string" ? target : target.name)),
    );
    elements.targetList.replaceChildren(
      ...state.targets.map((target) => {
        const label = this.element("label", "target-card");
        const input = this.element("input");
        input.type = "checkbox";
        input.name = "targets";
        input.value = target.name;
        input.checked = selected.has(target.name);
        const content = this.element("span", "target-card__content");
        const heading = this.element("span", "target-card__title");
        const name = this.element("span");
        name.append(this.icon(this.targetIcon(target.name)), ` ${target.label}`);
        const checkbox = this.element("span", "target-card__check");
        checkbox.append(this.icon("fa-check"));
        heading.append(name, checkbox);
        const description = this.element("p");
        description.textContent =
          target.kind === "mobile" ? "Simulator / Emulator über Appium" : "Echter Desktop-Browser";
        const meta = this.element("span", "target-card__meta");
        meta.append(this.icon(this.statusIcon(target.check?.status)), this.targetStatus(target.check));
        content.append(heading, description, meta);
        label.append(input, content);
        return label;
      }),
    );
  }

  static renderActions() {
    const actions = state.actions ?? [];
    elements.guidedActions.hidden = actions.length === 0;
    if (actions.length === 0) return;
    const automatic = actions.filter((action) => action.automatic).length;
    const manual = actions.length - automatic;
    elements.setupSummary.textContent = [
      automatic ? `${automatic} automatische Schritte` : "",
      manual ? `${manual} geführte Schritte` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  static applyJson() {
    try {
      const parsed = JSON.parse(elements.jsonEditor.value);
      currentConfig = parsed;
      this.populateForm(parsed);
      this.renderTargets();
      this.markDirty();
      this.showNotice("JSON wurde ins Formular übernommen. Zum Anwenden noch speichern.", "success");
    } catch (error) {
      this.showNotice(`JSON ist ungültig: ${this.errorMessage(error)}`, "error");
    }
  }

  static configFromForm() {
    const selected = [...document.querySelectorAll('input[name="targets"]:checked')].map((input) => input.value);
    if (selected.length === 0) throw new Error("Wähle mindestens einen Browser oder Simulator aus.");
    const previousTargets = new Map(
      (currentConfig.targets ?? []).map((target) => [typeof target === "string" ? target : target.name, target]),
    );
    const command = document.querySelector("#server-command").value.trim();
    const healthUrl = document.querySelector("#health-url").value.trim();
    const previousServer = currentConfig.webServer ?? {};
    const config = {
      ...currentConfig,
      name: document.querySelector("#project-name").value.trim(),
      baseUrl: document.querySelector("#base-url").value.trim(),
      targets: selected.map((name) => previousTargets.get(name) ?? name),
      specs: document
        .querySelector("#specs")
        .value.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    if (command) {
      config.webServer = {
        ...previousServer,
        command,
        cwd: document.querySelector("#server-cwd").value.trim() || ".",
        ...(healthUrl ? { healthUrl } : {}),
      };
      if (!healthUrl) delete config.webServer.healthUrl;
    } else {
      delete config.webServer;
    }
    return config;
  }

  static syncJsonFromForm() {
    try {
      elements.jsonEditor.value = JSON.stringify(this.configFromForm(), null, 2);
    } catch {
      // Keep the last complete JSON while the form is temporarily incomplete.
    }
  }

  static async save() {
    if (!elements.form.reportValidity()) return false;
    this.setButtonsBusy(true);
    try {
      const config = this.configFromForm();
      const stored = await this.request("/v1/workbench/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      currentConfig = stored.config;
      elements.jsonEditor.value = JSON.stringify(currentConfig, null, 2);
      this.markSaved("Gespeichert");
      this.showNotice("Konfiguration gespeichert und ab dem nächsten Lauf aktiv.", "success");
      return true;
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
      return false;
    } finally {
      this.setButtonsBusy(false);
    }
  }

  static async setup() {
    const targets = [...document.querySelectorAll('input[name="targets"]:checked')].map((input) => input.value);
    if (targets.length === 0) return this.showNotice("Wähle zuerst mindestens ein Ziel aus.", "error");
    this.setButtonsBusy(true);
    this.showNotice("Setup läuft. Größere Appium- oder Android-Downloads können einige Minuten dauern.");
    try {
      const actions = await this.request("/v1/workbench/setup", {
        method: "POST",
        body: JSON.stringify({
          targets,
          ...(targets.includes("chrome-android") ? { androidAvdName: "Browser_Testbench_API_36" } : {}),
        }),
      });
      const failed = actions.filter((action) => action.status === "failed");
      const manual = actions.filter((action) => action.status === "manual");
      this.showNotice(
        failed.length
          ? `${failed.length} Setup-Schritt(e) fehlgeschlagen: ${failed.map((action) => action.label).join(", ")}`
          : `Setup abgeschlossen.${manual.length ? ` ${manual.length} Schritt(e) bleiben manuell.` : ""}`,
        failed.length ? "error" : "success",
      );
      await this.refresh();
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.setButtonsBusy(false);
    }
  }

  static async run() {
    this.setButtonsBusy(true);
    elements.results.hidden = false;
    elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
    elements.resultTitle.textContent = "Tests laufen …";
    elements.resultCopy.textContent = "Projektserver und Browser werden vorbereitet.";
    elements.resultGrid.replaceChildren();
    this.setRunStatus("running");
    try {
      const run = await this.request("/v1/workbench/run", { method: "POST", body: "{}" });
      await this.pollRun(run.id);
    } catch (error) {
      this.setRunStatus("failed");
      elements.resultTitle.textContent = "Testlauf konnte nicht gestartet werden";
      elements.resultCopy.textContent = this.errorMessage(error);
    } finally {
      this.setButtonsBusy(false);
    }
  }

  static async pollRun(id) {
    let run;
    do {
      await new Promise((resolve) => setTimeout(resolve, 500));
      run = await this.request(`/v1/runs/${encodeURIComponent(id)}`);
      this.renderRun(run);
    } while (run.status === "running");
  }

  static renderRun(run) {
    this.setRunStatus(run.status);
    elements.resultTitle.textContent =
      run.status === "running" ? "Tests laufen …" : run.status === "passed" ? "Alles grün" : "Testlauf fehlgeschlagen";
    elements.resultCopy.textContent = `${run.name} · ${run.targets.length} Ziel(e) · Lauf ${run.id}`;
    elements.resultGrid.replaceChildren(
      ...run.targets.map((target) => {
        const card = this.element("article", "result-card");
        const title = this.element("div", "result-card__title");
        title.append(document.createTextNode(target.target), this.statusBadge(target.status));
        const copy = this.element("p");
        copy.textContent = `${target.tests.length} Test(s) · ${(target.durationMs / 1000).toFixed(1)} s`;
        card.append(title, copy);
        if (run.status !== "running") {
          const report = this.element("a");
          report.href = `/v1/runs/${encodeURIComponent(run.id)}/artifact?path=report.html`;
          report.target = "_blank";
          report.rel = "noreferrer";
          report.textContent = "HTML-Bericht öffnen";
          card.append(report);
        }
        return card;
      }),
    );
  }

  static setRunStatus(status) {
    const labels = { running: "Läuft", passed: "Bestanden", failed: "Fehlgeschlagen" };
    const icons = { running: "fa-circle-notch fa-spin", passed: "fa-check", failed: "fa-xmark" };
    elements.runStatus.className = `run-status status--${status}`;
    elements.runStatus.replaceChildren(this.icon(icons[status]), document.createTextNode(labels[status]));
  }

  static statusBadge(status) {
    const badge = this.element("span", `run-status status--${status}`);
    badge.textContent =
      { passed: "Bestanden", failed: "Fehlgeschlagen", unavailable: "Nicht verfügbar", running: "Läuft" }[status] ??
      status;
    return badge;
  }

  static markDirty() {
    elements.saveState.classList.remove("is-saved");
    elements.saveState.lastChild.textContent = " Ungespeichert";
  }

  static markSaved(label) {
    elements.saveState.classList.add("is-saved");
    elements.saveState.lastChild.textContent = ` ${label}`;
  }

  static setButtonsBusy(busy) {
    elements.form.setAttribute("aria-busy", String(busy));
    document.querySelectorAll("button, input, textarea").forEach((control) => {
      control.disabled = busy;
    });
  }

  static showNotice(message, kind = "") {
    elements.notice.hidden = false;
    elements.notice.className = `notice${kind ? ` is-${kind}` : ""}`;
    elements.notice.textContent = message;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(
      () => {
        elements.notice.hidden = true;
      },
      kind === "error" ? 9000 : 5000,
    );
  }

  static async request(path, options = {}, retry = true) {
    const headers = { ...(options.body ? { "content-type": "application/json" } : {}) };
    if (authorization) headers.authorization = `Bearer ${authorization}`;
    const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
    if (response.status === 401 && retry) {
      const token = window.prompt("Dieser Server ist geschützt. Bitte Bearer-Token eingeben:");
      if (token) {
        authorization = token;
        sessionStorage.setItem("btb-token", token);
        return this.request(path, options, false);
      }
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const issues = payload.issues?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(issues || payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  static errorMessage(error) {
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

  static targetIcon(name) {
    return (
      {
        chrome: "fa-circle",
        firefox: "fa-fire",
        safari: "fa-compass",
        edge: "fa-wave-square",
        "safari-ios": "fa-mobile-screen-button",
        "chrome-android": "fa-robot",
      }[name] ?? "fa-window-maximize"
    );
  }

  static platformIcon(platform) {
    return platform === "darwin" ? "fa-laptop" : platform === "win32" ? "fa-desktop" : "fa-terminal";
  }

  static targetStatus(check) {
    if (!check) return "Status unbekannt";
    return { ready: "Bereit", action: "Aktion nötig", blocked: "Noch nicht bereit", skip: "Nicht verfügbar" }[
      check.status
    ];
  }
}

void WorkbenchUi.initialize();
