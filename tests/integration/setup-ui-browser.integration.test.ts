import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TargetRegistry } from "../../src/config/target-registry.js";
import { TARGET_NAMES, type DoctorCheck } from "../../src/config/types.js";
import { ClientVersion } from "../../src/config/client-version.js";
import { TestbenchDefaults } from "../../src/config/defaults.js";
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

const chrome = (locale: "en-US" | "de-DE") => ({
  name: "chrome" as const,
  capabilities: {
    "goog:chromeOptions": {
      args: ["--headless=new", `--lang=${locale}`],
      prefs: { "intl.accept_languages": locale === "de-DE" ? "de-DE,de" : "en-US,en" },
    },
  },
});

async function waitForText(browser: BrowserSession, text: string, timeout = 15_000): Promise<void> {
  try {
    await browser.active.waitForText(text, timeout);
  } catch (error) {
    throw new Error(`Timed out waiting for UI text: ${text}`, { cause: error });
  }
}

describe("workbench UI browser flow", () => {
  browserTest(
    "navigates the responsive app shell and operates the workbench pages",
    async () => {
      let androidConnected = true;
      let androidName = "Pixel 8";
      let iosSigningReady = false;
      const inspectEnvironment = vi.spyOn(DoctorService, "inspect").mockImplementation(async () =>
        TARGET_NAMES.map((id) => {
          const android = id === "chrome-android";
          const ios = id === "safari-ios";
          return {
            id,
            label: TargetRegistry.definitions[id].label,
            status:
              id === "chrome" || ios || (android && androidConnected)
                ? ("ready" as const)
                : android
                  ? "action"
                  : "skip",
            detail:
              id === "chrome"
                ? "C:\\Program Files\\Google\\Chrome\\Application\\a-very-long-directory-name\\chrome.exe"
                : android
                  ? androidConnected
                    ? "1 connected device ready for Chrome testing."
                    : "No Android device or compatible emulator was found."
                  : ios
                    ? "1 simulator ready for Safari testing. 1 physical device needs attention."
                    : "Browser integration fixture",
            ...(android && androidConnected
              ? {
                  devices: [
                    {
                      id: "R5CT1234",
                      name: androidName,
                      platformVersion: "16",
                      state: "Connected",
                      deviceKind: "physical" as const,
                      compatible: true,
                      config: {
                        name: "chrome-android" as const,
                        deviceKind: "physical" as const,
                        deviceName: androidName,
                        platformVersion: "16",
                        udid: "R5CT1234",
                      },
                    },
                  ],
                }
              : ios
                ? {
                    devices: [
                      {
                        id: "IOS-DEVICE",
                        name: "iPhone",
                        platformVersion: "16.7.11",
                        state: "Connected",
                        deviceKind: "physical" as const,
                        compatible: iosSigningReady,
                        detail: iosSigningReady
                          ? "Connected via USB with signing available."
                          : "No Apple Development signing identity is available.",
                        ...(iosSigningReady ? {} : { documentationUrl: "/docs#ios-signing" }),
                        setupChecks: [
                          { id: "usb", label: "USB connection", ready: true, detail: "Connected directly by USB." },
                          {
                            id: "trust",
                            label: "Xcode device readiness",
                            ready: true,
                            detail: "The device is paired and available to Xcode.",
                          },
                          {
                            id: "developer-mode",
                            label: "Developer Mode",
                            ready: true,
                            detail: "Developer Mode is enabled.",
                          },
                          {
                            id: "signing",
                            label: "Apple Development signing",
                            ready: iosSigningReady,
                            detail: iosSigningReady
                              ? "The signing identity is valid."
                              : "No Apple Development signing identity is available.",
                          },
                        ],
                        config: {
                          name: "safari-ios" as const,
                          deviceKind: "physical" as const,
                          udid: "IOS-DEVICE",
                        },
                      },
                      {
                        id: "IOS-DEVICE-2",
                        name: "Second iPhone",
                        platformVersion: "17.0",
                        state: "Connected",
                        deviceKind: "physical" as const,
                        compatible: false,
                        detail: "Connect the second iPhone by USB.",
                        setupChecks: [
                          {
                            id: "usb",
                            label: "USB connection",
                            ready: false,
                            detail: "Connect the second iPhone by USB.",
                          },
                          { id: "trust", label: "Xcode device readiness", ready: false, detail: "Trust the device." },
                          {
                            id: "developer-mode",
                            label: "Developer Mode",
                            ready: false,
                            detail: "Enable Developer Mode.",
                          },
                          {
                            id: "signing",
                            label: "Apple Development signing",
                            ready: false,
                            detail: "Create a signing identity.",
                          },
                        ],
                        config: {
                          name: "safari-ios" as const,
                          deviceKind: "physical" as const,
                          udid: "IOS-DEVICE-2",
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
          id: "appium-uiautomator2",
          label: "Appium UiAutomator2",
          command: "browser-testbench setup --yes --targets chrome-android",
          automatic: true,
          status: "planned",
          detail: { key: "environment.setupDriverMissing" },
          targets: ["chrome-android"],
        },
        {
          id: "appium-xcuitest",
          label: "Appium XCUITest",
          automatic: true,
          status: "completed",
          detail: {
            key: "environment.setupDriverInstalled",
            parameters: { version: "12.12.4" },
          },
          targets: ["safari-ios"],
        },
        {
          id: "android-sdk",
          label: "Android SDK",
          automatic: false,
          status: "manual",
          detail: { key: "environment.avdInstallSdk" },
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
        await browser.start(chrome("en-US"));
        await browser.active.setWindowRect(500, 812);
        await browser.navigate(`${baseUrl}/setup`);
        await waitForText(browser, "Google Chrome");
        expect(await browser.active.execute("return document.querySelector('#app').dataset.liveReload")).toBe("true");

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
            window.__bannerAuthorization = options.headers instanceof Headers
              ? options.headers.get("authorization") ?? ""
              : options.headers?.authorization ?? "";
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
        await waitForText(browser, "Windows Testbench");
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
        expect(
          await browser.active.execute(
            "return ['safari-ios', 'chrome-android'].map(id => { const link = document.querySelector(`[data-check-id=\"${id}\"] a[href^=\"/docs#physical-\"]`); return { id, href: link?.getAttribute('href'), text: link?.textContent.trim() }; })",
          ),
        ).toEqual([
          { id: "safari-ios", href: "/docs#physical-ios", text: "documentation" },
          { id: "chrome-android", href: "/docs#physical-android", text: "documentation" },
        ]);
        expect(
          await browser.active.execute(
            "return document.querySelector('[data-check-id=\"safari-ios\"] .device-option a')?.getAttribute('href')",
          ),
        ).toBe("/docs#ios-signing");
        await browser.active.$('[data-check-id="chrome-android"] .device-options summary').click();
        expect(await browser.active.$('[data-check-id="chrome-android"] .device-option').getText()).toContain(
          "Physical device · Version 16 · Connected via USB",
        );
        await browser.active.waitForScript(
          "return document.documentElement.dataset.environmentStream === 'connected'",
          [],
          15_000,
        );
        await browser.active.execute(
          "window.__previousDeviceDetails = document.querySelector('[data-check-id=\"chrome-android\"] .device-options')",
        );
        androidName = "Pixel 8 Pro";
        events.publish({ type: "environment.changed", source: "android", occurredAt: new Date().toISOString() });
        await waitForText(browser, "Pixel 8 Pro");
        await browser.active.waitForScript(
          "return window.__previousDeviceDetails.isConnected && document.querySelector('[data-check-id=\"chrome-android\"] .device-options').open",
          [],
          15_000,
        );
        await browser.active.execute("window.__pageSurvivedEnvironmentUpdate = true");
        androidConnected = false;
        events.publish({ type: "environment.changed", source: "android", occurredAt: new Date().toISOString() });
        await waitForText(browser, "No Android device or compatible emulator was found.");
        expect(await browser.active.execute("return window.__pageSurvivedEnvironmentUpdate")).toBe(true);
        expect(await browser.active.$("#checks").getText()).not.toContain("Pixel 8");
        expect(await browser.active.$(".guided-actions__heading").getText()).toContain("Environment setup");
        expect(await browser.active.execute("return document.querySelector('#environment-setup') !== null")).toBe(true);
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
        await waitForText(browser, "codex is connected to Browser Testbench.");
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
        await browser.active.$("#debug-url").waitForDisplayed({ timeout: 15_000 });
        expect(await browser.active.execute("return document.querySelector('#debug-url').placeholder")).toBe(
          "http://127.0.0.1:3000",
        );
        expect(await browser.active.$("#test-target-list").getText()).toContain("Ready on this machine");
        expect(await browser.active.$("#test-target-list").getText()).toContain(
          "Not available on this operating system",
        );
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
        await waitForText(browser, "Busy");
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

        await browser.active.setWindowRect(1000, 812);
        expect(
          await browser.active.execute(`
            const card = [...document.querySelectorAll(".test-target")].find(item => item.querySelector(".test-target__actions > .button"));
            const command = card.querySelector(".command-block").getBoundingClientRect();
            const button = card.querySelector(".test-target__actions > .button").getBoundingClientRect();
            const status = card.querySelector(".test-target__status").getBoundingClientRect();
            const detail = card.querySelector(".test-target__content > small");
            return {
              containerType: getComputedStyle(card).containerType,
              actionsUseTwoRows: button.top > command.bottom,
              contentFitsCard: card.scrollWidth === card.clientWidth,
              statusFitsCard: status.right <= card.getBoundingClientRect().right,
              detailWraps: detail.scrollWidth === detail.clientWidth
            };
          `),
        ).toEqual({
          containerType: "inline-size",
          actionsUseTwoRows: true,
          contentFitsCard: true,
          statusFitsCard: true,
          detailWraps: true,
        });
        await browser.active.setWindowRect(1600, 812);
        expect(
          await browser.active.execute(`
            const card = [...document.querySelectorAll(".test-target")].find(item => item.querySelector(".test-target__actions > .button"));
            const command = card.querySelector(".command-block").getBoundingClientRect();
            const button = card.querySelector(".test-target__actions > .button").getBoundingClientRect();
            return Math.abs(command.top - button.top) < 1;
          `),
        ).toBe(true);
        await browser.active.setWindowRect(1000, 812);
        expect(
          await browser.active.execute(`
            const target = document.querySelector("#debug-target").getBoundingClientRect();
            const button = document.querySelector("#start-debug-session").getBoundingClientRect();
            const controls = document.querySelector(".debug-controls").getBoundingClientRect();
            const alternative = document.querySelector(".debug-command-alternative").getBoundingClientRect();
            const command = document.querySelector("#debug-open-command .command-block").getBoundingClientRect();
            return {
              sameRow: button.left > target.right,
              bottomAligned: Math.abs(target.bottom - button.bottom) < 1,
              balancedCommandSpacing: Math.abs(
                (alternative.top - controls.bottom) - (command.top - alternative.bottom)
              ) < 1
            };
          `),
        ).toEqual({ sameRow: true, bottomAligned: true, balancedCommandSpacing: true });
        await browser.active.setWindowRect(500, 812);
        expect(
          await browser.active.execute(`
            const controls = document.querySelector(".debug-controls").getBoundingClientRect();
            const url = document.querySelector("#debug-url").closest("label").getBoundingClientRect();
            const target = document.querySelector("#debug-target").getBoundingClientRect();
            const button = document.querySelector("#start-debug-session").getBoundingClientRect();
            return {
              urlUsesFullRow: Math.abs(url.left - controls.left) < 1 && Math.abs(url.right - controls.right) < 1,
              controlsOnNextRow: target.top > url.bottom && button.left > target.right,
              bottomAligned: Math.abs(target.bottom - button.bottom) < 1
            };
          `),
        ).toEqual({ urlUsesFullRow: true, controlsOnNextRow: true, bottomAligned: true });

        await browser.active.execute(`
          window.__debugSessions = [];
          window.__debugSessionFetch = window.fetch;
          window.fetch = async (path, options = {}) => {
            const requestPath = String(path);
            const method = options.method ?? "GET";
            const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
              status,
              headers: { "content-type": "application/json" }
            });
            if (requestPath === "/v1/sessions" && method === "POST") {
              window.__startedDebugSession = JSON.parse(options.body);
              window.__debugSessions = [{
                id: "ui-debug-session",
                target: window.__startedDebugSession.target,
                createdAt: "2026-09-23T10:00:00.000Z",
                runtime: {}
              }];
              return json(window.__debugSessions[0], 201);
            }
            if (requestPath === "/v1/sessions" && method === "GET") return json(window.__debugSessions);
            if (requestPath === "/v1/sessions/ui-debug-session/devtools") {
              return json({
                tool: "Chrome DevTools",
                automatic: true,
                url: "https://devtools.example/inspector.html?ws=localhost:45678/devtools/page/1"
              });
            }
            if (requestPath === "/v1/sessions/ui-debug-session" && method === "DELETE") {
              window.__closedDebugSession = true;
              window.__debugSessions = [];
              return json({ closed: true });
            }
            return window.__debugSessionFetch(path, options);
          };
        `);
        await browser.active.$("#start-debug-session").click();
        await browser.active.waitForScript(
          'return document.querySelectorAll("#debug-session-list .debug-session").length === 1',
          [],
          15_000,
        );
        expect(await browser.active.execute("return window.__startedDebugSession")).toEqual({
          target: "chrome",
          url: "http://127.0.0.1:5173/debug",
        });
        expect(
          await browser.active.execute(
            'return document.querySelector("#debug-session-list .open-devtools").getAttribute("href")',
          ),
        ).toBe("https://devtools.example/inspector.html?ws=localhost:45678/devtools/page/1");
        await browser.active.$("#debug-session-list .close-debug-session").click();
        await browser.active.waitForScript(
          'return !document.querySelector("#debug-session-list .debug-session")',
          [],
          15_000,
        );
        expect(await browser.active.execute("return window.__closedDebugSession")).toBe(true);

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
        await waitForText(browser, "was tested successfully");
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
        await waitForText(browser, "completed successfully");
        expect(await browser.active.execute<number>("return window.__verifiedTargets.length")).toBe(readyTargetCount);
        expect(await browser.active.execute<number>("return window.__maxActiveVerifications")).toBe(1);
        expect(await browser.active.$("#test-target-list").getText()).not.toContain("Shutdown");
        await browser.active.saveScreenshot(screenshotPath);

        const inspectionCountBeforeDocumentation = inspectEnvironment.mock.calls.length;
        await browser.active.devtools("Page.addScriptToEvaluateOnNewDocument", {
          source: `
            const platformFetch = window.fetch.bind(window);
            window.fetch = async (...argumentsList) => {
              const response = await platformFetch(...argumentsList);
              if (String(argumentsList[0]) !== "/v1/workbench") return response;
              const payload = await response.json();
              payload.platform = "darwin";
              payload.platformLabel = "macOS";
              return new Response(JSON.stringify(payload), {
                status: response.status,
                headers: { "content-type": "application/json" }
              });
            };
          `,
        });
        await browser.navigate(`${baseUrl}/docs`);
        expect(await browser.active.$(".docs-content").getText()).toContain("Automated tests");
        await waitForText(browser, "Set up your iPhone or iPad");
        await waitForText(browser, "Set up your Android device");
        expect(inspectEnvironment).toHaveBeenCalledTimes(inspectionCountBeforeDocumentation);
        expect(
          await browser.active.execute("return document.querySelector('#ios-mac-setup > summary').textContent.trim()"),
        ).toContain("Install Xcode and the iOS test tools");
        expect(
          await browser.active.execute("return document.querySelector('#android-tools > summary').textContent.trim()"),
        ).toContain("Install Android Platform Tools and Appium");
        expect(
          await browser.active.execute(
            "const mobile = document.querySelector('#mobile'); const nextSection = document.querySelector('#physical-android'); return { aboveDivider: getComputedStyle(nextSection).marginTop, belowDivider: getComputedStyle(mobile).paddingTop }",
          ),
        ).toEqual({ aboveDivider: "32px", belowDivider: "32px" });
        await browser.active.$("#ios-setup-checklist").scrollIntoView();
        await browser.active.$("#ios-setup-checklist .setup-checklist__heading button").click();
        await browser.active.waitForElement("#ios-setup-checklist .setup-checklist__step[data-step-id]", 15_000);
        expect(await browser.active.execute("return document.querySelectorAll('[data-step-id]').length")).toBe(8);
        expect(
          await browser.active.execute("return document.querySelectorAll('#ios-setup-checklist select option').length"),
        ).toBe(2);
        await browser.active.$("#ios-setup-checklist select").select(["IOS-DEVICE-2"], "value");
        await waitForText(browser, "Connect the second iPhone by USB.");
        await browser.active.$("#ios-setup-checklist select").select(["IOS-DEVICE"], "value");
        expect(
          await browser.active.execute(
            "return { current: document.querySelectorAll('#ios-setup-checklist .setup-checklist__step').length, groups: [...document.querySelectorAll('#ios-setup-checklist .setup-checklist__group')].map(group => group.open) }",
          ),
        ).toEqual({ current: 1, groups: [false, false] });
        expect(
          await browser.active.execute(
            "return document.querySelector('#ios-setup-checklist [data-step-id=access]').textContent",
          ),
        ).toContain("No Apple Development signing identity is available");
        expect(await browser.active.execute("return document.querySelector('#refresh-environment')")).toBeNull();
        expect(
          await browser.active.execute(
            "return document.querySelector('#ios-setup-checklist [data-step-id=device]').classList.contains('is-complete')",
          ),
        ).toBe(true);
        expect(
          await browser.active.execute(
            "return document.querySelector('#ios-setup-checklist [data-step-id=device] details') === null",
          ),
        ).toBe(true);
        expect(
          await browser.active.execute(
            "return document.querySelector('#ios-setup-checklist [data-step-id=access] details').open",
          ),
        ).toBe(false);
        await browser.active.execute("document.querySelector('#android-detailed-setup > summary').click()");
        await browser.active.waitForScript("return document.querySelector('#android-tools').open", [], 15_000);
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('#android-detailed-setup .docs-accordion')].filter(item => item.open).map(item => item.id)",
          ),
        ).toEqual(["android-tools"]);
        expect(
          await browser.active.execute(
            "const outerContent = document.querySelector('#android-detailed-setup > .docs-disclosure__content'); const firstItem = document.querySelector('#android-tools'); const innerContent = firstItem.querySelector('.docs-accordion__content'); return { marginTop: getComputedStyle(firstItem).marginTop, outerPaddingBottom: getComputedStyle(outerContent).paddingBottom, innerHasBottomPadding: parseFloat(getComputedStyle(innerContent).paddingBottom) > 0 }",
          ),
        ).toEqual({ marginTop: "0px", outerPaddingBottom: "0px", innerHasBottomPadding: true });
        await browser.active.execute("document.querySelector('#android-debugging > summary').click()");
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('#android-detailed-setup .docs-accordion')].filter(item => item.open).map(item => item.id)",
          ),
        ).toEqual(["android-debugging"]);
        await browser.active.execute("document.querySelector('#android-detailed-setup > summary').click()");
        await browser.active.execute("document.querySelector('#android-detailed-setup > summary').click()");
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('#android-detailed-setup .docs-accordion')].filter(item => item.open).map(item => item.id)",
          ),
        ).toEqual(["android-debugging"]);
        await browser.active.$("#ios-setup-checklist [data-step-id=access] summary").click();
        expect(await browser.active.$("#ios-setup-checklist [data-step-id=access] details").getText()).toContain(
          "WWDR G3",
        );
        expect(await browser.active.execute("return document.querySelector('#ios-detailed-setup').open")).toBe(false);
        await browser.active.$("#ios-setup-checklist [data-step-id=access] a[href='#ios-signing']").click();
        expect(await browser.active.execute("return document.querySelector('#ios-detailed-setup').open")).toBe(true);
        expect(await browser.active.execute("return document.querySelector('#ios-signing').open")).toBe(true);
        expect(
          await browser.active.execute(
            "return { ios: document.querySelectorAll('#ios-detailed-setup .docs-accordion').length, android: document.querySelectorAll('#android-detailed-setup .docs-accordion').length }",
          ),
        ).toEqual({ ios: 6, android: 4 });
        const iosDeviceGuide = browser.active.$("#ios-device-connection > summary");
        await iosDeviceGuide.scrollIntoView();
        await iosDeviceGuide.click();
        const iosSafariGuide = browser.active.$("#ios-safari-settings > summary");
        await iosSafariGuide.scrollIntoView();
        await iosSafariGuide.click();
        expect(
          await browser.active.execute(
            "return { device: document.querySelector('#ios-device-connection').open, safari: document.querySelector('#ios-safari-settings').open, signing: document.querySelector('#ios-signing').open }",
          ),
        ).toEqual({ device: false, safari: true, signing: false });
        expect(
          await browser.active.execute(
            "const item = document.querySelector('#ios-safari-settings'); return Math.round(item.querySelector(':scope > summary').getBoundingClientRect().width) === Math.round(item.getBoundingClientRect().width)",
          ),
        ).toBe(true);
        iosSigningReady = true;
        const refreshIosChecklist = browser.active.$("#ios-setup-checklist .setup-checklist__heading button");
        await refreshIosChecklist.scrollIntoView();
        await refreshIosChecklist.click();
        await browser.active.waitForElement("#ios-setup-checklist [data-step-id=access] input", 15_000);
        await browser.active.$("#ios-setup-checklist [data-step-id=access] input").click();
        expect(
          await browser.active.execute(
            "return document.querySelector('#ios-setup-checklist [data-step-id=access]').classList.contains('is-complete')",
          ),
        ).toBe(true);
        await browser.navigate(`${baseUrl}/docs`);
        await waitForText(browser, "Set up your iPhone or iPad");
        await browser.active.$("#ios-setup-checklist").scrollIntoView();
        await browser.active.$("#ios-setup-checklist .setup-checklist__heading button").click();
        await browser.active.waitForCount("#ios-setup-checklist [data-step-id=access]", 1, 15_000);
        expect(
          await browser.active.execute(
            "return document.querySelector('#ios-setup-checklist [data-step-id=access]').classList.contains('is-complete')",
          ),
        ).toBe(true);
        await browser.navigate(`${baseUrl}/docs#android-debugging`);
        expect(
          await browser.active.execute(
            "return { guide: document.querySelector('#android-detailed-setup').open, target: document.querySelector('#android-debugging').open, openItems: document.querySelectorAll('#android-detailed-setup .docs-accordion[open]').length }",
          ),
        ).toEqual({ guide: true, target: true, openItems: 1 });
        expect(await browser.active.execute("return document.querySelector('.docs-toc')")).toBeNull();
        expect(
          await browser.active.execute("return document.querySelectorAll('.sidebar__subnav .sidebar__sublink').length"),
        ).toBe(9);
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
        await waitForText(browser, "Google Chrome");
        expect(await browser.active.execute("return document.querySelector('#run-setup')")).toBeNull();
        expect(await browser.active.$("#setup-action-list").getText()).toContain("The driver is not installed yet.");
        expect(
          await browser.active.execute(
            "const content = document.querySelector('.guided-actions__content').getBoundingClientRect(); const list = document.querySelector('#setup-action-list').getBoundingClientRect(); return { left: list.left === content.left, right: list.right === content.right }",
          ),
        ).toEqual({ left: true, right: true });
        expect(
          await browser.active.execute(
            "const statuses = [...document.querySelectorAll('.setup-action__status')]; return { labels: statuses.map(status => status.textContent.trim()), aligned: new Set(statuses.map(status => status.getBoundingClientRect().right)).size === 1, sameWidth: new Set(statuses.map(status => status.getBoundingClientRect().width)).size === 1 }",
          ),
        ).toEqual({ labels: ["Install", "Installed", "Action required"], aligned: true, sameWidth: true });
        await browser.active.execute(`
          const originalFetch = window.fetch.bind(window);
          window.fetch = (...argumentsList) => {
            if (String(argumentsList[0]) !== "/v1/workbench/setup") return originalFetch(...argumentsList);
            window.__setupTargets = JSON.parse(argumentsList[1].body).targets;
            return new Promise(resolve => {
              window.__completeEnvironmentSetup = (response = new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) => resolve(response);
            });
          };
        `);
        await browser.active.$(".setup-action__status.is-planned").click();
        expect(await browser.active.$(".setup-action__status.is-planned").getText()).toBe("Installing \u2026");
        await browser.active.execute("window.__completeEnvironmentSetup()");
        await waitForText(browser, "Setup completed.");
        expect(await browser.active.execute("return window.__setupTargets")).toEqual(["chrome-android"]);
        await browser.active.$(".setup-action__status.is-planned").click();
        await browser.active.execute(`
          window.__completeEnvironmentSetup(new Response(JSON.stringify([{
            id: "appium-uiautomator2",
            label: "Appium UiAutomator2",
            automatic: true,
            status: "failed",
            detail: "npm registry certificate validation failed"
          }]), { status: 200, headers: { "content-type": "application/json" } }));
        `);
        await waitForText(
          browser,
          "1 setup step failed: Appium UiAutomator2: npm registry certificate validation failed",
        );
        await browser.active.$(".setup-action__status.is-planned").click();
        await browser.active.execute(`
          window.__completeEnvironmentSetup(new Response(JSON.stringify([{
            id: "android-sdk",
            label: "Chrome on Android",
            automatic: false,
            status: "manual",
            detail: "Install the Android SDK and Android Emulator, then run setup again."
          }]), { status: 200, headers: { "content-type": "application/json" } }));
        `);
        await waitForText(
          browser,
          "Automatic setup finished, but 1 step still requires attention: Chrome on Android: Install the Android SDK and Android Emulator, then run setup again.",
        );
        expect(await browser.active.execute("return document.querySelector('#notice').className")).toContain(
          "is-warning",
        );
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
    120_000,
  );

  browserTest(
    "opens the hosted DevTools frontend for a local Chrome session",
    async () => {
      const target = new BrowserSession();
      const viewer = new BrowserSession();

      try {
        await target.start({ name: "chrome", headless: true });
        const frontendUrl = await target.active.devToolsFrontendUrl();
        expect(frontendUrl).toContain(`ws=${TestbenchDefaults.LOOPBACK_HOST}:`);

        await viewer.start({ name: "chrome", headless: true });
        await viewer.navigate(frontendUrl!);
        await viewer.active.waitForScript(
          'return document.title.startsWith("DevTools -") && document.body.children.length > 2',
          [],
          15_000,
        );

        expect(await viewer.active.getTitle()).toMatch(/^DevTools -/);
      } finally {
        await viewer.close();
        await target.close();
      }
    },
    30_000,
  );

  browserTest(
    "presents remote host administration instead of connection controls",
    async () => {
      let finishInspection!: (checks: DoctorCheck[]) => void;
      const inspection = new Promise<DoctorCheck[]>((resolve) => {
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
        await browser.start(chrome("en-US"));
        await browser.navigate(`http://${remoteAddress.host}:${remoteAddress.port}/setup`);
        await browser.active.waitForScript(
          "return document.querySelector('#app').hasAttribute('data-v-app')",
          [],
          15_000,
        );
        const loadingState = await browser.active.execute<{
          busy: string | null;
          exists: boolean;
          fills: boolean;
          messageVisible: boolean;
          refreshInHeader: boolean;
          hidden?: boolean;
        }>(`
          const overlay = document.querySelector("#environment-analysis");
          const content = document.querySelector(".page-content");
          const appContent = document.querySelector(".app-content");
          const overlayRect = overlay?.getBoundingClientRect();
          const appContentRect = appContent.getBoundingClientRect();
          const headerRect = document.querySelector(".app-header").getBoundingClientRect();
          const messageRect = document.querySelector(".content-analysis__content").getBoundingClientRect();
          return {
            busy: content.getAttribute("aria-busy"),
            exists: Boolean(overlay),
            fills: Boolean(overlayRect && Math.abs(overlayRect.left - appContentRect.left) <= 1 && Math.abs(overlayRect.right - appContentRect.right) <= 1 && Math.abs(overlayRect.height - window.innerHeight) <= 1 && overlayRect.top >= headerRect.bottom - 1),
            messageVisible: messageRect.top >= headerRect.bottom && messageRect.bottom <= window.innerHeight,
            refreshInHeader: Boolean(document.querySelector(".topbar > .topbar__actions > #refresh-environment")),
            hidden: overlay?.hidden
          };
        `);
        finishInspection([
          {
            id: "chrome",
            label: "Google Chrome",
            status: "ready",
            detail: "Browser integration fixture",
          },
          {
            id: "firefox",
            label: "Mozilla Firefox",
            status: "skip",
            detail: "Browser integration fixture",
          },
        ]);
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
          messageVisible: true,
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

        await browser.active.waitForText(connected.remote!.clientName, 15_000);
        expect(await browser.active.$("#remote-client-list").getText()).toContain("connected");

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

        await browser.navigate(`http://${gatewayAddress.host}:${gatewayAddress.port}/docs#physical-ios`);
        await browser.active.execute("document.querySelector('#ios-detailed-setup').open = true");
        await browser.active.execute("document.querySelector('#ios-network-access').open = true");
        expect(await browser.active.$("#ios-network-access").getText()).toContain(
          "IP address of the Testbench that runs the tests",
        );
        await browser.active.execute("document.querySelector('#ios-device-connection').open = true");
        expect(await browser.active.$("#ios-device-connection").getText()).toContain("Window → Devices and Simulators");
        await browser.active.execute("document.querySelector('#ios-signing').open = true");
        expect(await browser.active.$("#ios-signing").getText()).toContain("Sign and run WebDriverAgent");
        expect(await browser.active.$("#ios-signing").getText()).toContain("Manage Certificates");
        expect(await browser.active.$("#ios-signing").getText()).toContain("Product → Test");
        expect(
          await browser.active.execute(
            "return document.querySelector('#physical-ios a[href=\"/setup#environment-setup\"]')?.textContent.trim()",
          ),
        ).toBe("Environment setup");
        expect(await browser.active.$("#physical-ios").getText()).not.toContain("YOUR-LAN-IP");

        await browser.navigate(`http://${gatewayAddress.host}:${gatewayAddress.port}/targets`);
        await browser.active.$("#debug-url").waitForDisplayed({ timeout: 15_000 });
        const gatewayWorkbench = (await fetch(`http://${gatewayAddress.host}:${gatewayAddress.port}/v1/workbench`, {
          headers: ClientVersion.headers(),
        }).then((response) => response.json())) as { localNetworkAddress?: string };
        const expectedApplicationUrl = gatewayWorkbench.localNetworkAddress
          ? `http://${gatewayWorkbench.localNetworkAddress}:3000`
          : "http://YOUR-LAN-IP:3000";
        expect(await browser.active.execute("return document.querySelector('#debug-url').placeholder")).toBe(
          expectedApplicationUrl,
        );
        expect(await browser.active.$("#local-network-address").getText()).toContain(
          gatewayWorkbench.localNetworkAddress ?? "this computer's LAN address",
        );
        expect(await browser.active.$("#project-client-example").getText()).toContain(expectedApplicationUrl);
        expect(await browser.active.$("#test-target-list").getText()).toContain("Ready on remote machine");
        expect(await browser.active.$("#test-target-list").getText()).toContain(
          "Not available on remote operating system",
        );

        await browser.navigate(`http://${gatewayAddress.host}:${gatewayAddress.port}/setup`);
        await browser.active.waitForText(identity.name, 15_000);

        await browser.active.execute(`
          window.__promptCalls = 0;
          window.prompt = () => {
            window.__promptCalls += 1;
            return null;
          };
        `);
        await fetch(`http://127.0.0.1:${remoteAddress.port}/v1/remote/clients/${connected.remote!.clientId}`, {
          method: "DELETE",
          headers: ClientVersion.headers(),
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

  browserTest(
    "can disconnect when the configured remote Testbench is offline",
    async () => {
      vi.spyOn(DoctorService, "inspect").mockResolvedValue([]);
      vi.spyOn(McpIntegrationService, "statuses").mockResolvedValue([]);
      const api = new ApiServer({ host: "127.0.0.1", port: 0 });
      const address = await api.start();
      const browser = new BrowserSession();

      try {
        await browser.start(chrome("en-US"));
        await browser.active.devtools("Page.addScriptToEvaluateOnNewDocument", {
          source: `
          window.__offlineRemote = true;
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (path, options = {}) => {
            const requestPath = String(path);
            if (window.__offlineRemote && requestPath === "/v1/workbench") {
              return new Response(JSON.stringify({ error: "Remote Testbench 'LLAKIE-ROG' is not reachable: fetch failed." }), {
                status: 502,
                headers: { "content-type": "application/json" }
              });
            }
            if (requestPath === "/v1/connections/status") {
              return new Response(JSON.stringify(window.__offlineRemote ? {
                mode: "remote",
                reachable: false,
                remote: {
                  instanceName: "LLAKIE-ROG",
                  platform: "win32",
                  role: "control",
                  url: "http://llakie-rog:55808"
                }
              } : { mode: "local", reachable: true }), {
                headers: { "content-type": "application/json" }
              });
            }
            if (requestPath === "/v1/connections/active" && options.method === "DELETE") {
              window.__offlineRemote = false;
              return new Response(JSON.stringify({ mode: "local" }), {
                headers: { "content-type": "application/json" }
              });
            }
            return originalFetch(path, options);
          };
          `,
        });

        await browser.navigate(`http://${address.host}:${address.port}/setup`);
        await browser.active.waitForText("LLAKIE-ROG", 15_000);
        await browser.active.waitForText("is not reachable: fetch failed", 15_000);
        expect(await browser.active.execute("return document.querySelector('#notice').textContent")).toContain(
          "is not reachable: fetch failed",
        );
        expect(await browser.active.$("#remote-banner").getText()).toContain("unreachable");
        await browser.active.$("#remote-banner-disconnect").click();
        await browser.active.waitForText("Connect to a central Testbench", 15_000);
        expect(
          await browser.active.execute(
            "return { connected: window.__offlineRemote, bannerHidden: document.querySelector('#remote-banner').hidden, panelHidden: document.querySelector('#remote-connection').hidden }",
          ),
        ).toEqual({ connected: false, bannerHidden: true, panelHidden: false });
        expect(await browser.active.execute("return document.querySelector('#notice')")).toBeNull();
      } finally {
        await browser.close();
        await api.stop();
        vi.restoreAllMocks();
      }
    },
    30_000,
  );

  browserTest(
    "renders the complete German UI on a remote Testbench",
    async () => {
      vi.spyOn(DoctorService, "inspect").mockResolvedValue(
        TARGET_NAMES.map((id) => {
          let label: DoctorCheck["label"] = TargetRegistry.definitions[id].label;
          if (id === "safari-ios") label = { key: "environment.safariIosLabel" };
          if (id === "chrome-android") label = { key: "environment.chromeAndroidLabel" };
          return {
            id,
            label,
            status: "ready" as const,
            detail: { key: "environment.browserNotFound" as const },
          };
        }),
      );
      vi.spyOn(SetupService, "plan").mockResolvedValue([]);
      vi.spyOn(McpIntegrationService, "statuses").mockResolvedValue([]);
      const directory = await mkdtemp(join(tmpdir(), "browser-testbench-i18n-ui-"));
      const clients = new AuthorizedRemoteClientStore(join(directory, "clients.json"));
      const api = new ApiServer(
        { host: "127.0.0.1", port: 0, remote: true },
        {
          identity: new RemoteHostIdentityStore(join(directory, "identity.json")),
          clients,
          pairing: new RemotePairingService(clients, () => {}),
          publisher: { start: async () => {}, stop: async () => {} },
        },
      );
      const address = await api.start();
      const browser = new BrowserSession();

      try {
        await browser.start(chrome("de-DE"));
        await browser.active.setWindowRect(390, 844);
        await browser.navigate(`http://${address.host}:${address.port}/setup`);
        await browser.active.waitForText("Browser und Geräte für deine Projekte", 15_000);
        await browser.active.waitForText("Chrome auf Android", 15_000);
        expect(await browser.active.execute("return document.documentElement.lang")).toBe("de");
        expect(await browser.active.$("#remote-connection").getText()).toContain("Verbundene Test-Clients");

        await browser.navigate(`http://${address.host}:${address.port}/targets`);
        await browser.active.waitForText("Alle Tests ausführen", 15_000);
        expect(await browser.active.$("#test-targets").getText()).toContain("Ziele für deine Tests");

        await browser.navigate(`http://${address.host}:${address.port}/docs#physical-ios`);
        await browser.active.waitForText("Physisches iPhone oder iPad verbinden", 15_000);
        expect(
          await browser.active.execute("return document.querySelector('#ios-network-access').textContent"),
        ).toContain("IP-Adresse der Testbench verwenden, die die Tests ausführt");
        expect(
          await browser.active.execute(
            "return document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      } finally {
        await browser.close();
        await api.stop();
        await rm(directory, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    },
    30_000,
  );
});
