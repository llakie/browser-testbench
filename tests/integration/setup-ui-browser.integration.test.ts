import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES } from "../../src/config/types.js";
import { BrowserSession } from "../../src/automation/browser-session.js";
import { DoctorService } from "../../src/setup/doctor-service.js";
import { McpIntegrationService, type McpClientId } from "../../src/setup/mcp-integration-service.js";
import { SetupService } from "../../src/setup/setup-service.js";
import { WorkbenchEvents } from "../../src/setup/workbench-events.js";
import { ApiServer } from "../../src/transports/api-server.js";
import {
  AuthorizedRemoteClientStore,
  RemoteCredentialStore,
  RemoteHostIdentityStore,
} from "../../src/remote/remote-client-store.js";
import { RemoteConnectionService } from "../../src/remote/remote-connection-service.js";
import { RemotePairingService } from "../../src/remote/remote-pairing-service.js";
import type { RemoteInstance } from "../../src/remote/remote-types.js";
import { RemoteTestbench } from "../../src/transports/testbench-client.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;
const platformLabel = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

describe("workbench UI browser flow", () => {
  browserTest(
    "navigates the responsive app shell and operates the workbench pages",
    async () => {
      let androidConnected = true;
      vi.spyOn(DoctorService, "inspect").mockImplementation(async () =>
        TARGET_NAMES.map((id) => {
          const android = id === "chrome-android";
          return {
            id,
            label: TargetRegistry.definitions[id].label,
            status: id === "chrome" || (android && androidConnected) ? ("ready" as const) : android ? "action" : "skip",
            detail:
              id === "chrome"
                ? "C:\\Program Files\\Google\\Chrome\\Application\\a-very-long-directory-name\\chrome.exe"
                : android
                  ? androidConnected
                    ? "1 connected device ready for Chrome testing."
                    : "No Android device or compatible emulator was found."
                  : "Browser integration fixture",
            ...(android && androidConnected
              ? {
                  devices: [
                    {
                      id: "R5CT1234",
                      name: "Pixel 8",
                      platformVersion: "16",
                      state: "Connected",
                      deviceKind: "physical" as const,
                      compatible: true,
                      config: {
                        name: "chrome-android" as const,
                        deviceKind: "physical" as const,
                        deviceName: "Pixel 8",
                        platformVersion: "16",
                        udid: "R5CT1234",
                      },
                    },
                  ],
                }
              : {}),
          };
        }),
      );
      vi.spyOn(SetupService, "plan").mockResolvedValue([
        {
          label: "Appium UiAutomator2",
          command: "browser-testbench setup --yes --targets chrome-android",
          automatic: true,
          status: "planned",
          detail: "Browser integration fixture",
          targets: ["chrome-android"],
        },
        {
          label: "Android SDK",
          automatic: false,
          status: "manual",
          detail: "Browser integration fixture",
        },
      ]);
      vi.spyOn(McpIntegrationService, "statuses").mockResolvedValue(
        (["codex", "claude-code", "gemini-cli", "copilot-vscode", "other"] as McpClientId[]).map((id) => ({
          id,
          label: id,
          installed: id === "codex",
          automatic: id === "codex",
          registered: false,
          current: false,
          command: id === "claude-code" ? "claude mcp add browser-testbench" : "test command",
          format: "command",
          detail: "Browser integration fixture",
          instruction: "Browser integration fixture",
        })),
      );
      const directory = await mkdtemp(join(tmpdir(), "browser-testbench-ui-flow-"));
      const screenshotPath = join(directory, "targets-ui.png");
      const events = new WorkbenchEvents();
      const api = new ApiServer({ host: "127.0.0.1", port: 0, liveReload: true }, { events });
      const address = await api.start();
      const baseUrl = `http://${address.host}:${address.port}`;
      const browser = new BrowserSession();

      try {
        await browser.start({ name: "chrome", headless: true });
        await browser.active.setWindowRect(500, 812);
        await browser.navigate(`${baseUrl}/setup`);
        await browser.active.waitForText("Google Chrome", 15_000);
        expect(
          await browser.active.execute(
            "return Boolean(document.querySelector('script[src=\"/ui-assets/live-reload.js\"]'))",
          ),
        ).toBe(true);

        expect(await browser.active.$("#host-badge").getText()).toContain(platformLabel);
        expect(await browser.active.$("#remote-connection").getText()).toContain("Connect to a central Testbench");
        expect(
          await browser.active.execute(
            "return { remote: document.querySelector('#remote-connection').open, environment: document.querySelector('#environment').open }",
          ),
        ).toEqual({ remote: false, environment: true });
        await browser.active.$("#remote-connection > summary").click();
        expect(
          await browser.active.execute(
            "return { remote: document.querySelector('#remote-connection').open, environment: document.querySelector('#environment').open }",
          ),
        ).toEqual({ remote: true, environment: false });
        const checkboxMetrics = await browser.active.execute<{ width: number; height: number; fontSize: number }>(
          "const input = document.querySelector('#remote-admin'); const label = input.closest('label'); const rect = input.getBoundingClientRect(); return { width: rect.width, height: rect.height, fontSize: parseFloat(getComputedStyle(label).fontSize) }",
        );
        expect(checkboxMetrics.width).toBeLessThanOrEqual(checkboxMetrics.fontSize * 1.25);
        expect(checkboxMetrics.height).toBeLessThanOrEqual(checkboxMetrics.fontSize * 1.25);
        await browser.active.$("#environment > summary").click();
        expect(
          await browser.active.execute(
            "return { remote: document.querySelector('#remote-connection').open, environment: document.querySelector('#environment').open }",
          ),
        ).toEqual({ remote: false, environment: true });
        await browser.active.execute(`
          sessionStorage.setItem("browser-testbench-token", "banner-token");
          window.__appShellFetch = window.fetch;
          window.__bannerAuthorization = "";
          window.fetch = async (path, options = {}) => {
            if (String(path) !== "/v1/connections/status") return window.__appShellFetch(path, options);
            window.__bannerAuthorization = options.headers?.authorization ?? "";
            return new Response(JSON.stringify({
              mode: "remote",
              reachable: false,
              remote: {
                instanceName: "Windows Testbench",
                platform: "win32",
                role: "control",
                url: "http://windows.test:55808"
              }
            }), { status: 200, headers: { "content-type": "application/json" } });
          };
          window.dispatchEvent(new Event("browser-testbench:authorization-changed"));
        `);
        await browser.active.waitForText("Windows Testbench", 15_000);
        const bannerStatus = await browser.active.execute<{
          authorization: string;
          retryVisible: boolean;
          text: string;
        }>(`
          return {
            authorization: window.__bannerAuthorization,
            retryVisible: !document.querySelector("#remote-banner-retry").hidden,
            text: document.querySelector("#remote-banner").textContent
          };
        `);
        expect(bannerStatus).toMatchObject({
          authorization: "Bearer banner-token",
          retryVisible: true,
        });
        expect(bannerStatus.text).toContain("Windows Testbench");
        expect(bannerStatus.text).toContain("Windows · control · unreachable");
        await browser.active.$("#remote-banner-retry").click();
        expect(await browser.active.execute("return window.__bannerAuthorization")).toBe("Bearer banner-token");
        await browser.active.execute(
          "window.fetch = window.__appShellFetch; sessionStorage.removeItem('browser-testbench-token')",
        );
        const stickyHeader = await browser.active.execute<{
          position: string;
          headerTop: number;
          bannerTop: number;
          bannerBottom: number;
          topbarTop: number;
        }>(
          "const banner = document.querySelector('#remote-banner'); banner.hidden = false; window.scrollTo(0, document.body.scrollHeight); const header = document.querySelector('.app-header').getBoundingClientRect(); const bannerRect = banner.getBoundingClientRect(); const topbar = document.querySelector('.topbar').getBoundingClientRect(); return { position: getComputedStyle(document.querySelector('.app-header')).position, headerTop: header.top, bannerTop: bannerRect.top, bannerBottom: bannerRect.bottom, topbarTop: topbar.top }",
        );
        expect(stickyHeader).toMatchObject({ position: "sticky", headerTop: 0, bannerTop: 0 });
        expect(stickyHeader.topbarTop).toBe(stickyHeader.bannerBottom);
        await browser.active.execute("document.querySelector('#remote-banner').hidden = true; window.scrollTo(0, 0)");
        expect(
          await browser.active.execute(
            "const card = [...document.querySelectorAll('.check-card')].find(candidate => candidate.textContent.includes('Google Chrome')); const detail = card.querySelector('.check-card__detail'); const style = getComputedStyle(detail); return { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, truncated: detail.scrollWidth > detail.clientWidth, title: detail.title }",
          ),
        ).toEqual({
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          truncated: true,
          title: "C:\\Program Files\\Google\\Chrome\\Application\\a-very-long-directory-name\\chrome.exe",
        });
        expect(await browser.active.$(".environment-group--capabilities .subsection-heading").getText()).toContain(
          "Availability on this machine",
        );
        await browser.active.$(".check-card--device .device-options summary").click();
        expect(await browser.active.$(".check-card--device .device-option").getText()).toContain(
          "Physical device · Version 16 · Connected via USB",
        );
        await browser.active.waitForScript(
          "return document.documentElement.dataset.environmentStream === 'connected'",
          [],
          15_000,
        );
        await browser.active.execute(
          "window.__previousDeviceDetails = document.querySelector('.check-card--device .device-options')",
        );
        events.publish({ type: "environment.changed", source: "android", occurredAt: new Date().toISOString() });
        await browser.active.waitForScript(
          "return !window.__previousDeviceDetails.isConnected && document.querySelector('.check-card--device .device-options').open",
          [],
          15_000,
        );
        await browser.active.execute("window.__pageSurvivedEnvironmentUpdate = true");
        androidConnected = false;
        events.publish({ type: "environment.changed", source: "android", occurredAt: new Date().toISOString() });
        await browser.active.waitForText("No Android device or compatible emulator was found.", 15_000);
        expect(await browser.active.execute("return window.__pageSurvivedEnvironmentUpdate")).toBe(true);
        expect(await browser.active.$("#checks").getText()).not.toContain("Pixel 8");
        expect(await browser.active.$(".guided-actions__heading").getText()).toContain("Environment setup");
        expect(await browser.active.$(".integration-card").getText()).toContain("Connect an AI assistant through MCP");
        expect(
          await browser.active.execute(
            "const select = document.querySelector('#mcp-client'); const status = document.querySelector('#mcp-status'); const content = document.querySelector('.integration-card__content'); const selectRect = select.getBoundingClientRect(); const statusRect = status.getBoundingClientRect(); return { appearance: getComputedStyle(select).appearance, hasCaretSpace: parseFloat(getComputedStyle(select).paddingRight) >= 44, consistentGap: statusRect.top - selectRect.bottom === parseFloat(getComputedStyle(content).rowGap), caret: Boolean(document.querySelector('.select-control > .fa-chevron-down')) }",
          ),
        ).toEqual({ appearance: "none", hasCaretSpace: true, consistentGap: true, caret: true });
        await browser.active.execute(`
          const originalFetch = window.fetch.bind(window);
          window.fetch = (...argumentsList) => {
            if (String(argumentsList[0]) !== "/v1/workbench/mcp") return originalFetch(...argumentsList);
            const client = { id: "codex", label: "codex", installed: true, automatic: true, registered: true, current: true, command: "test command", format: "command", detail: "Connected", instruction: "Browser integration fixture" };
            return new Promise(resolve => {
              window.__completeMcpRegistration = () => resolve(new Response(JSON.stringify(client), { status: 200, headers: { "content-type": "application/json" } }));
            });
          };
        `);
        await browser.active.$("#register-mcp").click();
        expect(await browser.active.$("#register-mcp").getText()).toBe("Connecting \u2026");
        expect(
          await browser.active.execute("return document.querySelector('#register-mcp').getAttribute('aria-busy')"),
        ).toBe("true");
        await browser.active.execute("window.__completeMcpRegistration()");
        await browser.active.waitForText("codex is connected to Browser Testbench.");
        await browser.active.execute(`
          const client = document.querySelector("#mcp-client");
          client.value = "claude-code";
          client.dispatchEvent(new Event("change", { bubbles: true }));
        `);
        expect(await browser.active.$("#mcp-command").getText()).toContain("claude mcp add");

        await browser.active.$("#menu-toggle").click();
        expect(await browser.active.execute("return document.documentElement.classList.contains('is-menu-open')")).toBe(
          true,
        );
        await browser.active.execute('document.querySelector("#sidebar-backdrop").click()');
        expect(await browser.active.execute("return document.documentElement.classList.contains('is-menu-open')")).toBe(
          false,
        );

        await browser.navigate(`${baseUrl}/targets`);
        expect(
          await browser.active.execute("return Boolean(document.querySelector('#debug-target + .fa-chevron-down'))"),
        ).toBe(true);
        await browser.active.$("#project-client-example .copy-command").waitForClickable();
        await browser.active.execute(`
          window.__busyFetch = window.fetch;
          window.fetch = async (path, options = {}) => {
            if (String(path) === "/v1/verify") {
              return new Response(JSON.stringify({ target: "chrome", status: "passed", durationMs: 1, runtime: {} }), {
                status: 200,
                headers: { "content-type": "application/json" }
              });
            }
            const response = await window.__busyFetch(path, options);
            if (String(path) !== "/v1/workbench") return response;
            const payload = await response.json();
            const target = payload.testTargets.find(candidate => candidate.ready) ?? payload.testTargets[0];
            target.ready = true;
            target.busy = true;
            return new Response(JSON.stringify(payload), {
              status: response.status,
              headers: { "content-type": "application/json" }
            });
          };
        `);
        await browser.active.$(".test-target__actions > .button").click();
        await browser.active.waitForText("Busy", 15_000);
        expect(
          await browser.active.execute(
            `return [...document.querySelectorAll(".test-target")].find(target => target.querySelector(".test-target__status")?.textContent.includes("Busy"))?.querySelector(".test-target__actions > .button")?.disabled`,
          ),
        ).toBe(true);
        await browser.active.execute("window.fetch = window.__busyFetch");
        events.publish({ type: "environment.changed", source: "android", occurredAt: new Date().toISOString() });
        await browser.active.waitForScript(
          `return ![...document.querySelectorAll(".test-target__status")].some(status => status.textContent.includes("Busy"))`,
          [],
          15_000,
        );
        expect(await browser.active.$("#project-install-command").getText()).toContain(
          "npm install --save-dev browser-testbench",
        );
        expect(await browser.active.$("#project-install-command").getText()).not.toContain("file:");
        await browser.active.execute(
          `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.__copiedCommand = value; } } });`,
        );
        await browser.active.$("#project-client-example .copy-command").click();
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toContain("RemoteTestbench");
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toContain("availableTargets");
        expect(await browser.active.execute<string>("return window.__copiedCommand")).not.toContain("testbench.config");

        await browser.active.execute(`
          const target = document.querySelector("#debug-target");
          target.value = "chrome";
          target.dispatchEvent(new Event("change", { bubbles: true }));
          const url = document.querySelector("#debug-url");
          url.value = "http://127.0.0.1:5173/debug";
          url.dispatchEvent(new Event("input", { bubbles: true }));
        `);
        await browser.active.$("#debug-open-command .copy-command").click();
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toBe(
          "npx browser-testbench open --target chrome --url http://127.0.0.1:5173/debug",
        );
        expect(await browser.active.$("#debug-tools-note").getText()).toContain("desktop browser");

        await browser.active.execute(
          'document.querySelector("#test-target-list .copy-command").scrollIntoView({ block: "center" })',
        );
        await browser.active.$("#test-target-list .copy-command").click();
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toMatch(/^[a-z0-9-]+$/);
        expect(
          await browser.active.execute<string>(
            'return document.querySelector("#test-target-list .copy-command").getAttribute("aria-label")',
          ),
        ).toBe("Copy target ID");

        await browser.active.execute(`
          const originalFetch = window.fetch.bind(window);
          window.fetch = (...argumentsList) => String(argumentsList[0]) === "/v1/verify"
            ? new Promise((resolve, reject) => setTimeout(() => originalFetch(...argumentsList).then(resolve, reject), 500))
            : originalFetch(...argumentsList);
        `);
        await browser.active.$("#test-target-list .test-target__actions .button").click();
        expect(await browser.active.$("#test-target-list .test-target__actions .button").getText()).toBe(
          "Test running …",
        );
        await browser.active.waitForText("was tested successfully", 15_000);
        await browser.active.$("#verify-all-targets").waitForClickable({ timeout: 15_000 });

        await browser.active.execute(`
          const previousFetch = window.fetch.bind(window);
          window.__verifiedTargets = [];
          window.__activeVerifications = 0;
          window.__maxActiveVerifications = 0;
          window.fetch = async (...argumentsList) => {
            if (String(argumentsList[0]) !== "/v1/verify") return previousFetch(...argumentsList);
            const target = JSON.parse(argumentsList[1].body).target;
            window.__verifiedTargets.push(target);
            window.__activeVerifications += 1;
            window.__maxActiveVerifications = Math.max(window.__maxActiveVerifications, window.__activeVerifications);
            await new Promise(resolve => setTimeout(resolve, 20));
            window.__activeVerifications -= 1;
            return new Response(JSON.stringify({ target, status: "passed", durationMs: 20, runtime: {} }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          };
        `);
        const readyTargetCount = await browser.active.execute<number>(
          "return document.querySelectorAll('#test-target-list .test-target__actions .button').length",
        );
        await browser.active.$("#verify-all-targets").click();
        await browser.active.waitForText("tests completed successfully", 15_000);
        expect(await browser.active.execute<number>("return window.__verifiedTargets.length")).toBe(readyTargetCount);
        expect(await browser.active.execute<number>("return window.__maxActiveVerifications")).toBe(1);
        expect(await browser.active.$("#test-target-list").getText()).not.toContain("Shutdown");
        await browser.active.saveScreenshot(screenshotPath);

        await browser.navigate(`${baseUrl}/docs`);
        expect(await browser.active.$(".docs-content").getText()).toContain("Automated tests");
        expect(await browser.active.execute("return document.querySelector('.docs-toc')")).toBeNull();
        expect(
          await browser.active.execute("return document.querySelectorAll('.sidebar__subnav .sidebar__sublink').length"),
        ).toBe(6);
        expect(
          await browser.active.execute(
            "return document.querySelector('.sidebar__subnav .sidebar__sublink').getAttribute('href')",
          ),
        ).toBe("#start");
        await browser.active.$("#menu-toggle").click();
        expect(await browser.active.execute("return document.documentElement.classList.contains('is-menu-open')")).toBe(
          true,
        );
        expect(
          await browser.active.execute<string>(
            "return document.querySelector('.sidebar__link[aria-current=\"page\"]').textContent.trim()",
          ),
        ).toBe("Documentation");

        await browser.navigate(`${baseUrl}/setup`);
        expect(await browser.active.execute("return document.querySelector('.sidebar__subnav')")).toBeNull();
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('.sidebar__link')].some(link => link.textContent.includes('Licenses'))",
          ),
        ).toBe(false);
        expect(
          await browser.active.execute("return document.querySelector('.sidebar__collapse').textContent.trim()"),
        ).toBe("");
        expect(
          await browser.active.execute(
            "return document.querySelector('.sidebar__collapse').getAttribute('aria-label')",
          ),
        ).toBe("Collapse menu");
        expect(await browser.active.execute("return document.querySelector('.app-content > footer')")).toBeNull();
        expect(await browser.active.execute("return document.querySelectorAll('.sidebar__footer-link').length")).toBe(
          3,
        );

        await browser.active.setWindowRect(1000, 812);
        await browser.navigate(`${baseUrl}/setup`);
        await browser.active.waitForText("Google Chrome", 15_000);
        expect(await browser.active.execute("return document.querySelector('#run-setup')")).toBeNull();
        expect(
          await browser.active.execute(
            "const content = document.querySelector('.guided-actions__content').getBoundingClientRect(); const list = document.querySelector('#setup-action-list').getBoundingClientRect(); return { left: list.left === content.left, right: list.right === content.right }",
          ),
        ).toEqual({ left: true, right: true });
        expect(
          await browser.active.execute(
            "const statuses = [...document.querySelectorAll('.setup-action__status')]; return { labels: statuses.map(status => status.textContent.trim()), aligned: new Set(statuses.map(status => status.getBoundingClientRect().right)).size === 1, sameWidth: new Set(statuses.map(status => status.getBoundingClientRect().width)).size === 1 }",
          ),
        ).toEqual({ labels: ["Install", "Action required"], aligned: true, sameWidth: true });
        await browser.active.execute(`
          const originalFetch = window.fetch.bind(window);
          window.fetch = (...argumentsList) => {
            if (String(argumentsList[0]) !== "/v1/workbench/setup") return originalFetch(...argumentsList);
            window.__setupTargets = JSON.parse(argumentsList[1].body).targets;
            return new Promise(resolve => {
              window.__completeEnvironmentSetup = () => resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
            });
          };
        `);
        await browser.active.$(".setup-action__status.is-planned").click();
        expect(await browser.active.$(".setup-action__status.is-planned").getText()).toBe("Installing \u2026");
        await browser.active.execute("window.__completeEnvironmentSetup()");
        await browser.active.waitForText("Setup completed.");
        expect(await browser.active.execute("return window.__setupTargets")).toEqual(["chrome-android"]);
        expect(
          await browser.active.execute(
            "const button = document.querySelector('#sidebar-collapse').getBoundingClientRect(); const icon = document.querySelector('#sidebar-collapse i').getBoundingClientRect(); return button.right - icon.right < icon.left - button.left",
          ),
        ).toBe(true);
        expect(
          await browser.active.execute(
            "return document.querySelector('#sidebar-collapse').getBoundingClientRect().bottom <= document.querySelector('.sidebar__footer').getBoundingClientRect().top",
          ),
        ).toBe(true);
        await browser.active.$("#sidebar-collapse").click();
        expect(
          await browser.active.execute("return document.documentElement.classList.contains('is-sidebar-collapsed')"),
        ).toBe(true);
        expect(
          await browser.active.execute(
            "const mark = document.querySelector('.sidebar__brand .brand__mark').getBoundingClientRect(); return { width: mark.width, height: mark.height }",
          ),
        ).toEqual({ width: 40, height: 40 });
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('.sidebar__footer-link')].filter((item) => getComputedStyle(item).display !== 'none').map((item) => item.getAttribute('href'))",
          ),
        ).toEqual(["/health"]);
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('.check-card--device')].every((card) => getComputedStyle(card).gridColumnStart === 'span 2')",
          ),
        ).toBe(true);
        expect(
          await browser.active.execute(
            "return document.documentElement.scrollWidth === document.documentElement.clientWidth",
          ),
        ).toBe(true);
        await browser.active.setWindowRect(500, 812);
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('.sidebar__footer-link')].filter((item) => getComputedStyle(item).display !== 'none').length",
          ),
        ).toBe(3);
      } finally {
        await browser.close();
        await api.stop();
        vi.restoreAllMocks();
      }
    },
    60_000,
  );

  browserTest(
    "presents remote host administration instead of connection controls",
    async () => {
      let finishInspection!: (checks: []) => void;
      const inspection = new Promise<[]>((resolve) => {
        finishInspection = resolve;
      });
      vi.spyOn(DoctorService, "inspect").mockReturnValue(inspection);
      vi.spyOn(McpIntegrationService, "statuses").mockResolvedValue([
        {
          id: "codex",
          label: "Codex",
          installed: true,
          automatic: true,
          registered: false,
          current: false,
          command: "test command",
          format: "command",
          detail: "Browser integration fixture",
          instruction: "Browser integration fixture",
        },
      ]);
      const directory = await mkdtemp(join(tmpdir(), "browser-testbench-remote-ui-"));
      const clients = new AuthorizedRemoteClientStore(join(directory, "clients.json"));
      const announcements: string[] = [];
      const remote = new ApiServer(
        { host: "127.0.0.1", port: 0, remote: true },
        {
          identity: new RemoteHostIdentityStore(join(directory, "identity.json")),
          clients,
          pairing: new RemotePairingService(clients, (message) => announcements.push(message)),
          publisher: { start: async () => {}, stop: async () => {} },
        },
      );
      const remoteAddress = await remote.start();
      const browser = new BrowserSession();
      let gateway: ApiServer | undefined;

      try {
        await browser.start({ name: "chrome", headless: true });
        await browser.navigate(`http://${remoteAddress.host}:${remoteAddress.port}/setup`);
        const loadingState = await browser.active.execute<{
          busy: string | null;
          exists: boolean;
          fills: boolean;
          refreshInHeader: boolean;
          hidden?: boolean;
        }>(`
          const overlay = document.querySelector("#environment-analysis");
          const content = document.querySelector(".page-content");
          const overlayRect = overlay?.getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          const headerRect = document.querySelector(".app-header").getBoundingClientRect();
          return {
            busy: content.getAttribute("aria-busy"),
            exists: Boolean(overlay),
            fills: Boolean(overlayRect && Math.abs(overlayRect.top - contentRect.top) <= 1 && Math.abs(overlayRect.right - contentRect.right) <= 1 && Math.abs(overlayRect.bottom - contentRect.bottom) <= 1 && Math.abs(overlayRect.left - contentRect.left) <= 1 && overlayRect.top >= headerRect.bottom),
            refreshInHeader: Boolean(document.querySelector(".topbar > .topbar__actions > #refresh-environment")),
            hidden: overlay?.hidden
          };
        `);
        finishInspection([]);
        await browser.active.waitForText("Connected test clients", 15_000);
        const loadedState = await browser.active.execute<{ busy: string | null; hidden?: boolean }>(`
          const overlay = document.querySelector("#environment-analysis");
          return {
            busy: document.querySelector(".page-content").getAttribute("aria-busy"),
            hidden: overlay?.hidden
          };
        `);
        expect.soft(loadingState).toMatchObject({
          busy: "true",
          exists: true,
          fills: true,
          refreshInHeader: true,
          hidden: false,
        });
        expect.soft(loadedState).toMatchObject({ busy: "false", hidden: true });
        await browser.active.$("#remote-connection > summary").click();
        const panelText = await browser.active.$("#remote-connection").getText();
        expect(panelText).not.toContain("Connect to a central Testbench");
        expect(panelText).toContain("Pair and manage clients that use this Testbench over the network.");
        expect(panelText).toContain("No clients have connected yet.");
        expect(
          await browser.active.execute(
            "return { manual: document.querySelector('#remote-manual').hidden, discovery: document.querySelector('#discover-remotes').hidden }",
          ),
        ).toEqual({ manual: true, discovery: true });

        const remoteUrl = `http://${remoteAddress.host}:${remoteAddress.port}`;
        const identity = (await fetch(`${remoteUrl}/v1/remote/identity`).then((response) => response.json())) as Omit<
          RemoteInstance,
          "url"
        >;
        const discovered = { ...identity, url: remoteUrl };
        const connections = new RemoteConnectionService(new RemoteCredentialStore(join(directory, "credentials.json")));
        gateway = new ApiServer(
          { host: "127.0.0.1", port: 0 },
          { discovery: { discover: async () => [discovered] }, connections },
        );
        const gatewayAddress = await gateway.start();
        const testbench = new RemoteTestbench({ server: `http://${gatewayAddress.host}:${gatewayAddress.port}` });
        const pairing = await testbench.connectTestbench(discovered);
        const code = announcements[0]!.match(/\d{6}$/)?.[0];
        const connected = await testbench.completePairing((pairing as { pairingId: string }).pairingId, code!);

        await browser.navigate(`http://${gatewayAddress.host}:${gatewayAddress.port}/setup`);
        await browser.active.waitForText(identity.name, 15_000);
        await vi.waitFor(
          async () =>
            expect(
              await browser.active.execute<boolean>("return document.querySelector('#remote-connection').hidden"),
            ).toBe(true),
          { timeout: 15_000 },
        );
        expect(await browser.active.execute("return document.querySelector('#remote-connection').hidden")).toBe(true);

        await browser.active.execute(`
          window.__promptCalls = 0;
          window.prompt = () => {
            window.__promptCalls += 1;
            return null;
          };
        `);
        await fetch(`http://127.0.0.1:${remoteAddress.port}/v1/remote/clients/${connected.remote!.clientId}`, {
          method: "DELETE",
        });
        await browser.active.waitForText("Connect to a central Testbench", 15_000);
        expect(
          await browser.active.execute(
            "return { bannerHidden: document.querySelector('#remote-banner').hidden, panelHidden: document.querySelector('#remote-connection').hidden, promptCalls: window.__promptCalls }",
          ),
        ).toEqual({ bannerHidden: true, panelHidden: false, promptCalls: 0 });
      } finally {
        await browser.close();
        await gateway?.stop();
        await remote.stop();
        await rm(directory, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    },
    45_000,
  );
});
