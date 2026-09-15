import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureServer } from "../../src/support/fixture-server.js";
import { ApiServer } from "../../src/transports/api-server.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;

describe("REST browser control", () => {
  browserTest(
    "drives and captures Chrome through the loopback API",
    async () => {
      const fixture = new FixtureServer();
      const fixtureUrl = await fixture.start();
      const api = new ApiServer({ host: "127.0.0.1", port: 0, token: "integration-secret" });
      const address = await api.start();
      const baseUrl = `http://${address.host}:${address.port}`;
      const headers = { authorization: "Bearer integration-secret", "content-type": "application/json" };
      const outputDirectory = await mkdtemp(join(tmpdir(), "browser-testbench-api-"));
      const screenshotPath = join(outputDirectory, "api.png");

      try {
        const started = await fetch(`${baseUrl}/v1/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({ target: "chrome", url: fixtureUrl, headless: true }),
        });
        expect(started.status).toBe(201);
        expect(
          await fetch(`${baseUrl}/v1/session/type`, {
            method: "POST",
            headers,
            body: JSON.stringify({ selector: "#name", value: "REST" }),
          }).then((response) => response.status),
        ).toBe(200);
        expect(
          await fetch(`${baseUrl}/v1/session/click`, {
            method: "POST",
            headers,
            body: JSON.stringify({ selector: "#submit" }),
          }).then((response) => response.status),
        ).toBe(200);
        const inspection = await fetch(`${baseUrl}/v1/session/inspect`, { headers }).then((response) =>
          response.text(),
        );
        expect(inspection).toContain("Browser Testbench Fixture");
        const screenshot = await fetch(`${baseUrl}/v1/session/screenshot`, {
          method: "POST",
          headers,
          body: JSON.stringify({ path: screenshotPath }),
        });
        const captured = (await screenshot.json()) as { path: string; base64: string };
        expect(captured.path).toBe(screenshotPath);
        expect(captured.base64.length).toBeGreaterThan(100);
        expect(
          await fetch(`${baseUrl}/v1/session`, { method: "DELETE", headers }).then((response) => response.status),
        ).toBe(200);

        const created = (await fetch(`${baseUrl}/v1/runs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ url: fixtureUrl, targets: ["chrome"], headless: true }),
        }).then((response) => response.json())) as { id: string };
        let run: { status: string } = { status: "running" };
        for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          run = (await fetch(`${baseUrl}/v1/runs/${created.id}`, { headers }).then((response) => response.json())) as {
            status: string;
          };
        }
        expect(run.status).toBe("passed");
        const artifacts = (await fetch(`${baseUrl}/v1/runs/${created.id}/artifacts`, { headers }).then((response) =>
          response.json(),
        )) as Array<{ path: string }>;
        expect(artifacts.map((artifact) => artifact.path)).toContain("summary.json");
        const summary = await fetch(`${baseUrl}/v1/runs/${created.id}/artifact?path=summary.json`, { headers });
        expect(summary.status).toBe(200);
        expect(await summary.text()).toContain(created.id);
        const traversal = await fetch(`${baseUrl}/v1/runs/${created.id}/artifact?path=../package.json`, { headers });
        expect(traversal.status).not.toBe(200);
      } finally {
        await api.stop();
        await fixture.stop();
      }
    },
    45_000,
  );
});
