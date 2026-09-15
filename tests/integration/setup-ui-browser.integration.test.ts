import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserSession } from "../../src/automation/browser-session.js";
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
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toContain("availableTargets");
        expect(await browser.active.execute<string>("return window.__copiedCommand")).not.toContain("testbench.config");
        expect(
          await browser.active.execute<string>(
            'return document.querySelector("#project-client-example .copy-command").getAttribute("aria-label")',
          ),
        ).toBe("Befehl kopieren");
        await browser.active.execute(`
          const target = document.querySelector("#debug-target");
          target.value = "chrome";
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
        await browser.active.execute(
          'document.querySelector("#test-target-list .copy-command").scrollIntoView({ block: "center" })',
        );
        await browser.active.$("#test-target-list .copy-command").click();
        expect(await browser.active.execute<string>("return window.__copiedCommand")).toMatch(/^[a-z0-9-]+$/);
        expect(
          await browser.active.execute<string>(
            'return document.querySelector("#test-target-list .copy-command").getAttribute("aria-label")',
          ),
        ).toBe("Ziel-ID kopieren");
        await browser.active.execute(`
          const client = document.querySelector("#mcp-client");
          client.value = "claude-code";
          client.dispatchEvent(new Event("change", { bubbles: true }));
        `);
        expect(await browser.active.$("#mcp-command").getText()).toContain("claude mcp add");
        expect(await browser.active.$(".integration-card").getText()).toContain("KI-Assistent über MCP anbinden");
        await browser.active.saveScreenshot(screenshotPath);
        expect(await browser.active.$("#host-badge").getText()).toContain("macOS");
        expect(await browser.active.$("#connect").getText()).toContain("Testbench verwenden");
        expect(await browser.active.execute("return document.querySelector('#configuration') === null")).toBe(true);
        expect(
          await browser.active.execute("return document.querySelectorAll('#test-target-list .test-target').length"),
        ).toBeGreaterThan(0);
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
