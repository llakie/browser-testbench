import { SessionManager } from "../automation/session-manager.js";
import type { StartSessionInput } from "../config/input-schemas.js";
import type { VerificationResult } from "../config/types.js";
import { FixtureServer } from "../support/fixture-server.js";
import { IosVerificationCleanup } from "./ios-verification-cleanup.js";
import { TargetCatalogService } from "./target-catalog-service.js";
import { VerificationStore } from "./verification-store.js";

export class TargetVerificationService {
  static async run(
    sessions: SessionManager,
    input: Pick<StartSessionInput, "target" | "headless">,
  ): Promise<VerificationResult> {
    const target = await TargetCatalogService.resolve(input.target);
    const fixture = new FixtureServer();
    const url = await fixture.start();
    const startedAt = Date.now();
    let sessionId: string | undefined;
    try {
      const session = await sessions.start({ ...input, url });
      sessionId = session.id;
      const controller = sessions.get(session.id);
      await controller.elementAction({ action: "fill", selector: "#name", value: "Testbench" });
      await controller.click("#submit");
      await controller.wait({ type: "elementText", selector: "#result", text: "Hello Testbench" });
      await VerificationStore.record(input.target, session.runtime);
      return {
        target: input.target,
        status: "passed",
        durationMs: Date.now() - startedAt,
        runtime: session.runtime,
      };
    } finally {
      if (sessionId) await sessions.close(sessionId).catch(() => undefined);
      await IosVerificationCleanup.run(target);
      await fixture.stop();
    }
  }
}
