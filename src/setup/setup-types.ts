import type { TargetName } from "../config/types.js";

export interface SetupAction {
  label: string;
  command?: string;
  automatic: boolean;
  status: "planned" | "completed" | "failed" | "manual";
  detail?: string;
  targets?: TargetName[];
}
