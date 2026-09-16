import type { DoctorCheck } from "../config/types.js";

export class OutputFormatter {
  static doctor(checks: DoctorCheck[]): string {
    const width = Math.max(...checks.map((check) => check.id.length), 6);
    return checks
      .map((check) => {
        const action = check.action ? `\n${" ".repeat(9 + width)}${check.action}` : "";
        return `${check.status.toUpperCase().padEnd(7)} ${check.id.padEnd(width)}  ${check.detail}${action}`;
      })
      .join("\n");
  }
}
