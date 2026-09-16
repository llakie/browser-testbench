import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ApiServer } from "../../src/transports/api-server.js";

const browserTest = process.env.BTB_BROWSER_TESTS === "1" ? it : it.skip;
const execFileAsync = promisify(execFile);

describe("CLI browser control", () => {
  browserTest(
    "verifies a concrete target through the running Testbench server",
    async () => {
      const api = new ApiServer({ host: "127.0.0.1", port: 0 });
      const address = await api.start();
      const server = `http://${address.host}:${address.port}`;

      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", "verify", "chrome", "--headless", "--server", server, "--json"],
          { cwd: process.cwd(), timeout: 30_000 },
        );
        expect(JSON.parse(stdout)).toMatchObject({ target: "chrome", status: "passed" });
        expect(await fetch(`${server}/v1/sessions`).then((response) => response.json())).toEqual([]);
      } finally {
        await api.stop();
      }
    },
    45_000,
  );
});
