import { SessionManager } from "../automation/session-manager.js";
import type { StartSessionInput } from "../config/input-schemas.js";
import type { VerificationResult } from "../config/types.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { FixtureServer } from "../support/fixture-server.js";
import { VerificationStore } from "./verification-store.js";
import { TargetCatalogService } from "./target-catalog-service.js";
import { IosPhysicalUrlGuard } from "../automation/ios-physical-url-guard.js";

export class TargetVerificationService {
  static async run(
    sessions: SessionManager,
    input: Pick<StartSessionInput, "target" | "headless">,
    ownerId = "local",
  ): Promise<VerificationResult> {
    const fixture = new FixtureServer();
    const startedAt = Date.now();
    let sessionId: string | undefined;
    try {
      let url = await fixture.start();
      const target = await TargetCatalogService.resolve(input.target);
      if (target.config.name === "safari-ios" && target.config.deviceKind === "physical") {
        url = IosPhysicalUrlGuard.fixtureUrl(url);
      }
      const session = await sessions.start(
        { ...input, url, lockTimeoutMs: TestbenchDefaults.TARGET_LOCK_TIMEOUT_MS },
        ownerId,
      );
      sessionId = session.id;
      const controller = sessions.get(session.id, ownerId);
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
      if (sessionId) await sessions.close(sessionId, ownerId).catch(() => undefined);
      await fixture.stop();
    }
  }
}
