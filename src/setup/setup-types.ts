import type { TargetName } from "../config/types.js";
import type { LocalizedFields } from "../config/types.js";

export interface SetupAction {
  id: string;
  label: string;
  command?: string;
  automatic: boolean;
  status: "planned" | "completed" | "failed" | "manual";
  detail?: string;
  targets?: TargetName[];
  messages?: LocalizedFields;
}
