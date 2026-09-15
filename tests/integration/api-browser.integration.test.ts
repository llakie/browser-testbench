import { mkdtemp, stat, writeFile } from "node:fs/promises";
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
      const pdfPath = join(outputDirectory, "page.pdf");
      const uploadPath = join(outputDirectory, "upload.txt");
      await writeFile(uploadPath, "upload fixture");
      const testbench = new RemoteTestbench({
        server: `http://${address.host}:${address.port}`,
        token: "integration-secret",
      });

      try {
        const browser = await testbench.open({
          target: "chrome",
          url: fixtureUrl,
          headless: true,
          downloadDir: outputDirectory,
        });
        expect(browser.id).toBeTruthy();
        expect(await browser.evaluate<string>("return document.title")).toBe("Browser Testbench Fixture");
        await browser.setPermission("geolocation", "granted", fixtureUrl);
        await browser.setGeolocation(52.52, 13.405);
        await browser.setNetworkConditions({ latencyMs: 1 });
        await browser.blockUrls([]);
        await browser.mockFetch("/api/mock", { status: 201, body: "mocked" });
        expect(await browser.evaluate<string>("return fetch('/api/mock').then(response => response.text())")).toBe(
          "mocked",
        );
        await browser.clearFetchMocks();
        await browser.fill('[placeholder="Your name"]', "REST");
        await expect(browser.count("placeholder=Your name")).rejects.toThrow();
        await expect(browser.count("//input")).rejects.toThrow();
        await browser.append("#name", " Client");
        await browser.waitForValue("#name", "REST Client");
        expect((await browser.state("#name")).value).toBe("REST Client");
        await browser.check("#terms");
        await browser.waitForState("#terms", "checked");
        expect((await browser.state("#terms")).selected).toBe(true);
        await browser.select("#country", "United Kingdom", "text");
        expect((await browser.state("#country")).value).toBe("gb");
        await browser.upload("#upload", uploadPath);
        expect(await browser.count(".item")).toBe(2);
        await browser.waitForCount(".item", 2);
        await browser.focus("#name");
        expect((await browser.state("#name")).focused).toBe(true);
        await browser.blur("#name");
        await browser.hover("#submit");
        expect((await browser.elementScreenshotBase64("#fixture-form")).length).toBeGreaterThan(100);
        await browser.click('button[data-testid="submit"]');
        await browser.waitForText("Hello REST Client");
        await browser.waitForNetworkIdle(100, 5_000);
        const inspection = await browser.inspect();
        expect(inspection.title).toBe("Browser Testbench Fixture");
        for (const element of inspection.elements) {
          expect(
            await browser.evaluate<boolean>("return Boolean(document.querySelector(arguments[0]))", [element.selector]),
          ).toBe(true);
        }
        await browser.click("#alert");
        expect((await browser.alert("accept")).text).toBe("Fixture alert");
        await browser.switchFrame("#fixture-frame");
        expect((await browser.state("#frame-button")).text).toBe("Frame action");
        await browser.switchFrame();
        expect(
          await browser.evaluate<string>(
            'return document.querySelector("#shadow-host").shadowRoot.querySelector("#shadow-button").textContent',
          ),
        ).toBe("Shadow action");
        await browser.setStorage("local", "fixture", "stored");
        expect(await browser.storage("local")).toMatchObject({ fixture: "stored" });
        await browser.setCookie({ name: "fixture", value: "cookie" });
        expect(await browser.cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fixture" })]));
        const savedState = await browser.snapshotState();
        await browser.deleteCookie();
        await browser.deleteStorage("local");
        await browser.restoreState(savedState);
        expect(await browser.storage("local")).toMatchObject({ fixture: "stored" });
        await browser.click("#download");
        expect(await browser.waitForDownload("fixture.txt")).toMatchObject({
          path: join(outputDirectory, "fixture.txt"),
        });
        const initialWindow = (await browser.windows()).current;
        await browser.newWindow();
        await browser.waitForWindowCount(2);
        expect((await browser.windows()).handles).toHaveLength(2);
        await browser.closeWindow();
        await browser.switchWindow(initialWindow);
        await browser.screenshot(screenshotPath, true);
        expect((await stat(screenshotPath)).size).toBeGreaterThan(100);
        await browser.printPdf(pdfPath);
        expect((await stat(pdfPath)).size).toBeGreaterThan(100);
        expect(await browser.accessibility()).toBeTruthy();
        const diagnostics = await browser.diagnostics();
        expect(
          diagnostics.some((entry) => entry.type === "console" && entry.message?.includes("fixture submitted")),
        ).toBe(true);
        expect(diagnostics.some((entry) => entry.type === "request" && entry.url?.includes("/api/ping"))).toBe(true);
        expect(diagnostics.some((entry) => entry.type === "response" && entry.url?.includes("/api/ping"))).toBe(true);
        await browser.clearDiagnostics();
        expect(await browser.diagnostics()).toEqual([]);
        await browser.close();
      } finally {
        await api.stop();
        await fixture.stop();
      }
    },
    45_000,
  );
});
