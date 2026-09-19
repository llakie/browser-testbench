import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../../src/infrastructure/process-manager.js";
import { TestbenchPaths } from "../../src/infrastructure/paths.js";

describe("ManagedProcess", () => {
  it.runIf(process.platform !== "win32")(
    "does not leave its stop timeout active after the process closes",
    async () => {
      const process_ = new ManagedProcess(
        TestbenchPaths.shellCommand([process.execPath, "-e", "setInterval(() => {}, 1_000)"]),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      const startedAt = Date.now();
      await process_.stop();

      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
  );
});
