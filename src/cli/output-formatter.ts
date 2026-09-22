import type { DoctorCheck } from "../config/types.js";
import { Translator } from "../i18n/translator.js";
import type { SetupAction } from "../setup/setup-types.js";

export class OutputFormatter {
  private static readonly english = new Translator("en");

  static doctor(checks: DoctorCheck[]): string {
    const width = Math.max(...checks.map((check) => check.id.length), 6);
    return checks
      .map((check) => {
        const action = check.action ? `\n${" ".repeat(9 + width)}${check.action}` : "";
        return `${check.status.toUpperCase().padEnd(7)} ${check.id.padEnd(width)}  ${check.detail}${action}`;
      })
      .join("\n");
  }

  static setup(actions: SetupAction[]): string {
    return actions
      .map((action) => {
        const label = this.english.text(action.label);
        let command = "";
        if (action.command) command = ` — ${action.command}`;
        const detail = this.english.text(action.detail);
        let detailLine = "";
        if (detail) detailLine = `\n          ${detail}`;
        return `${action.status.toUpperCase().padEnd(9)} ${label}${command}${detailLine}`;
      })
      .join("\n");
  }
}
