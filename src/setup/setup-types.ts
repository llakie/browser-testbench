import type { TargetName } from "../config/types.js";
import type { TranslatableText } from "../i18n/translator.js";

export interface SetupAction {
  id: string;
  label: TranslatableText;
  command?: string;
  automatic: boolean;
  status: "planned" | "completed" | "failed" | "manual";
  detail?: TranslatableText;
  targets?: TargetName[];
}
