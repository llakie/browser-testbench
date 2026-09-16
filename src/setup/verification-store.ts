import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TestbenchPaths } from "../infrastructure/paths.js";

export interface VerificationRecord {
  target: string;
  verifiedAt: string;
  runtime?: Record<string, unknown>;
}

export class VerificationStore {
  static async record(target: string, runtime?: Record<string, unknown>): Promise<void> {
    const directory = TestbenchPaths.data("verified");
    await mkdir(directory, { recursive: true });
    const value: VerificationRecord = { target, verifiedAt: new Date().toISOString(), runtime };
    await writeFile(TestbenchPaths.data("verified", `${target}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  static async read(target: string): Promise<VerificationRecord | undefined> {
    try {
      return JSON.parse(
        await readFile(TestbenchPaths.data("verified", `${target}.json`), "utf8"),
      ) as VerificationRecord;
    } catch {
      return undefined;
    }
  }
}
