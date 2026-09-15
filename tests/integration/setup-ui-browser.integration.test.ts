import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserSession } from "../../src/automation/browser-session.js";
import { InputSchemas } from "../../src/config/input-schemas.js";
import { ApiServer } from "../../src/transports/api-server.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;

describe("setup UI browser flow", () => {
  browserTest(
    "shows environment setup and project-to-Testbench commands",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "browser-testbench-ui-flow-"));
      const screenshotPath = join(directory, "setup-ui.png");
      const api = new ApiServer({ host: "127.0.0.1", port: 0 });
      const address = await api.start();
      const browser = new BrowserSession();

      try {
        await browser.start({ name: "chrome", headless: true });
        await browser.active.setWindowRect(500, 812);
        await browser.navigate(`http://${address.host}:${address.port}/setup`);
        await browser.active.$("#project-client-example .copy-command").waitForClickable();
        await browser.active.execute(
          `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.__copiedCommand = value; } } });`,
        );
        await browser.active.$("#project-client-example .copy-command").click();
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toContain("RemoteTestbench");
        expect(
          await browser.active.execute<string>(
            'return document.querySelector("#project-client-example .copy-command").getAttribute("aria-label")',
          ),
        ).toBe("Befehl kopieren");
        await browser.active.execute(`
          const target = document.querySelector("#debug-target");
          target.value = JSON.stringify({ name: "chrome" });
          target.dispatchEvent(new Event("change", { bubbles: true }));
          const url = document.querySelector("#debug-url");
          url.value = "http://127.0.0.1:5173/debug";
          url.dispatchEvent(new Event("input", { bubbles: true }));
          document.querySelector("#debug-open-command .copy-command").scrollIntoView({ block: "center" });
        `);
        await browser.active.$("#debug-open-command .copy-command").click();
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toBe(
          "npx browser-testbench open --target chrome --url http://127.0.0.1:5173/debug",
        );
        expect(await browser.active.$("#debug-tools-note").getText()).toContain("Desktopbrowser");
        await browser.active.execute('document.querySelector("#copy-config").scrollIntoView({ block: "center" })');
        await browser.active.$("#copy-config").click();
        const generatedConfig = JSON.parse(await browser.active.execute<string>("return window.__copiedCommand"));
        expect(InputSchemas.remoteConfig.parse(generatedConfig)).toMatchObject({
          server: `http://${address.host}:${address.port}`,
          targetPolicy: "available",
        });
        expect(generatedConfig.targets.length).toBeGreaterThan(0);
        expect(await browser.active.$("#config-message").getText()).toContain("Zwischenablage");
        await browser.active.execute(`
          window.__downloadName = "";
          window.__downloadUrl = "";
          URL.createObjectURL = () => "blob:generated-config";
          URL.revokeObjectURL = () => {};
          HTMLAnchorElement.prototype.click = function () {
            window.__downloadName = this.download;
            window.__downloadUrl = this.href;
          };
        `);
        await browser.active.execute('document.querySelector("#download-config").scrollIntoView({ block: "center" })');
        await browser.active.$("#download-config").click();
        expect(await browser.active.execute<string>("return `${window.__downloadName}|${window.__downloadUrl}`")).toBe(
          "testbench.config.json|blob:generated-config",
        );
        expect(await browser.active.$("#config-message").getText()).toContain("heruntergeladen");
        await browser.active.execute(`
          const client = document.querySelector("#mcp-client");
          client.value = "claude-code";
          client.dispatchEvent(new Event("change", { bubbles: true }));
        `);
        expect(await browser.active.$("#mcp-command").getText()).toContain("claude mcp add");
        expect(await browser.active.$(".integration-card").getText()).toContain("KI-Assistent über MCP anbinden");
        await browser.active.saveScreenshot(screenshotPath);
        expect(await browser.active.$("#host-badge").getText()).toContain("macOS");
        expect(await browser.active.$("#connect").getText()).toContain("Projekt anbinden und Test starten");
        expect(
          await browser.active.execute(
            "return Boolean(document.querySelector('#configuration').compareDocumentPosition(document.querySelector('#connect')) & Node.DOCUMENT_POSITION_FOLLOWING)",
          ),
        ).toBe(true);
        expect(await browser.active.$(".environment-group--capabilities .subsection-heading").getText()).toContain(
          "Verfügbarkeit auf diesem Rechner",
        );
        expect(await browser.active.execute("return document.querySelectorAll('#target-list').length")).toBe(0);
        expect(
          await browser.active.execute(
            "return document.documentElement.scrollWidth === document.documentElement.clientWidth",
          ),
        ).toBe(true);
        expect(await browser.active.execute("return document.querySelectorAll('.steps').length")).toBe(0);
        expect(await browser.active.execute("return document.querySelectorAll('.use-case-grid').length")).toBe(0);

        await browser.active.setWindowRect(1000, 812);
        expect(
          await browser.active.execute(
            "return [...document.querySelectorAll('.check-card--device')].every((card) => getComputedStyle(card).gridColumnStart === 'span 2')",
          ),
        ).toBe(true);
      } finally {
        await browser.close();
        await api.stop();
      }
    },
    45_000,
  );
});
