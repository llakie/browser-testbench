import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserSession } from "../../src/automation/browser-session.js";
import { FixtureServer } from "../../src/support/fixture-server.js";
import { ApiServer } from "../../src/transports/api-server.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;

class SetupUiTestSupport {
  static async waitForText(browser: BrowserSession, selector: string, text: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await browser.active.$(selector).getText()).includes(text)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`Timed out waiting for '${text}' in '${selector}'.`);
  }
}

describe("setup UI browser flow", () => {
  browserTest(
    "configures, saves, and runs a project from the guided page",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "browser-testbench-ui-flow-"));
      const configPath = join(directory, "testbench.config.json");
      const screenshotPath = join(directory, "setup-ui.png");
      const fixture = new FixtureServer();
      const fixtureUrl = await fixture.start();
      const api = new ApiServer({ host: "127.0.0.1", port: 0, configPath });
      const address = await api.start();
      const browser = new BrowserSession();

      try {
        await browser.start({ name: "chrome", headless: true });
        await browser.navigate(`http://${address.host}:${address.port}/setup`);
        await browser.active.$("#project-name").waitForClickable();
        await browser.active.$("#project-name").setValue("guided-ui-suite");
        await browser.active.$("#base-url").setValue(fixtureUrl);
        await browser.active.$("#server-command").clearValue();
        await browser.active.$("#specs").setValue(resolve("examples/smoke.spec.mjs"));
        await browser.active.execute(
          `document.querySelectorAll('input[name="targets"]').forEach((input) => { input.checked = input.value === "chrome"; input.dispatchEvent(new Event("input", { bubbles: true })); });`,
        );
        await browser.active.$("#save-and-run").waitForClickable();
        await browser.active.$("#save-and-run").click();
        await SetupUiTestSupport.waitForText(browser, "#result-title", "Alles grün", 30_000);
        await browser.active.saveScreenshot(screenshotPath);

        const persisted = JSON.parse(await readFile(configPath, "utf8"));
        expect(persisted).toMatchObject({
          name: "guided-ui-suite",
          baseUrl: fixtureUrl,
          targets: ["chrome"],
        });
        expect(await browser.active.$("#host-badge").getText()).toContain("macOS");
        expect(await browser.active.$("#result-title").getText()).toBe("Alles grün");
      } finally {
        await browser.close();
        await api.stop();
        await fixture.stop();
      }
    },
    45_000,
  );
});
