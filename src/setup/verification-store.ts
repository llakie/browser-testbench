import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { TargetName } from "../config/types.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

export interface VerificationRecord {
  target: TargetName;
  verifiedAt: string;
  runtime?: Record<string, unknown>;
}

export class VerificationStore {
  static async record(target: TargetName, runtime?: Record<string, unknown>): Promise<void> {
    const directory = TestbenchPaths.cache("verified");
    await mkdir(directory, { recursive: true });
    const value: VerificationRecord = { target, verifiedAt: new Date().toISOString(), runtime };
    await writeFile(TestbenchPaths.cache("verified", `${target}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  static async read(target: TargetName): Promise<VerificationRecord | undefined> {
    try {
      return JSON.parse(
        await readFile(TestbenchPaths.cache("verified", `${target}.json`), "utf8"),
      ) as VerificationRecord;
    } catch {
      return undefined;
    }
  }
}
