import type { DoctorCheck, TargetConfig, TargetRunResult } from "../config/types.js";
import { DoctorService } from "../setup/doctor-service.js";

export interface TargetSelection {
  runnable: TargetConfig[];
  unavailable: TargetRunResult[];
  checks: DoctorCheck[];
}

export class TargetSelector {
  static async resolve(targets: TargetConfig[]): Promise<TargetSelection> {
    const checks = await DoctorService.inspect([...new Set(targets.map((target) => target.name))]);
    const targetChecks = new Map(checks.map((check) => [check.id, check]));
    const runnable: TargetConfig[] = [];
    const unavailable: TargetRunResult[] = [];
    for (const target of targets) {
      const check = targetChecks.get(target.name);
      if (check?.status === "ready") {
        runnable.push(target);
        continue;
      }
      unavailable.push({
        target: target.name,
        status: "unavailable",
        durationMs: 0,
        tests: [],
        error: check?.action ?? check?.detail ?? "Target availability could not be determined.",
      });
    }
    return { runnable, unavailable, checks };
  }
}
