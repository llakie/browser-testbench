import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureServer } from "../../src/support/fixture-server.js";
import { ApiServer } from "../../src/transports/api-server.js";
import { RemoteTestbench } from "../../src/transports/testbench-client.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;

describe("REST browser control", () => {
  browserTest(
    "drives and captures Chrome through the project client",
    async () => {
      const fixture = new FixtureServer();
      const fixtureUrl = await fixture.start();
      const api = new ApiServer({ host: "127.0.0.1", port: 0, token: "integration-secret" });
      const address = await api.start();
      const outputDirectory = await mkdtemp(join(tmpdir(), "browser-testbench-api-"));
      const screenshotPath = join(outputDirectory, "api.png");
      const testbench = new RemoteTestbench({
        server: `http://${address.host}:${address.port}`,
        token: "integration-secret",
      });

      try {
        const browser = await testbench.open({ target: "chrome", url: fixtureUrl, headless: true });
        expect(browser.id).toBeTruthy();
        await browser.type("#name", "REST");
        await browser.click("#submit");
        await browser.waitForText("Hello REST");
        expect((await browser.inspect()).title).toBe("Browser Testbench Fixture");
        await browser.screenshot(screenshotPath);
        expect((await stat(screenshotPath)).size).toBeGreaterThan(100);
        const diagnostics = await browser.diagnostics();
        expect(
          diagnostics.some((entry) => entry.type === "console" && entry.message?.includes("fixture submitted")),
        ).toBe(true);
        expect(diagnostics.some((entry) => entry.type === "request" && entry.url?.includes("/api/ping"))).toBe(true);
        await browser.close();
      } finally {
        await api.stop();
        await fixture.stop();
      }
    },
    45_000,
  );
});
