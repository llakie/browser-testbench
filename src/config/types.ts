import type { TranslatableText } from "../i18n/translator.js";

export const TARGET_NAMES = ["chrome", "firefox", "safari", "edge", "safari-ios", "chrome-android"] as const;

export type TargetName = (typeof TARGET_NAMES)[number];
export type TargetKind = "desktop" | "mobile";
export type MobileDeviceKind = "simulator" | "emulator" | "physical";
export type CheckStatus = "ready" | "action" | "blocked" | "skip";

export interface TargetConfig {
  name: TargetName;
  enabled?: boolean;
  headless?: boolean;
  deviceName?: string;
  platformVersion?: string;
  avd?: string;
  udid?: string;
  deviceKind?: MobileDeviceKind;
  iosTeamId?: string;
  iosSigningId?: string;
  wdaBundleId?: string;
  initialUrl?: string;
  downloadDir?: string;
  capabilities?: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  label: TranslatableText;
  status: CheckStatus;
  detail: TranslatableText;
  action?: TranslatableText;
  commands?: string[];
  devices?: TargetDeviceOption[];
}

export interface TargetDeviceOption {
  id: string;
  name: string;
  platformVersion?: string;
  state?: string;
  deviceKind?: MobileDeviceKind;
  detail?: TranslatableText;
  documentationUrl?: string;
  setupChecks?: DeviceSetupCheck[];
  compatible: boolean;
  config: TargetConfig;
}

export interface DeviceSetupCheck {
  id: "usb" | "trust" | "developer-mode" | "signing";
  label: TranslatableText;
  ready: boolean;
  detail: TranslatableText;
}

export interface TargetDefinition {
  name: TargetName;
  label: string;
  kind: TargetKind;
  supportedPlatforms: NodeJS.Platform[];
  serial: boolean;
}

export interface TestTarget {
  id: string;
  browser: TargetName;
  label: TranslatableText;
  kind: TargetKind;
  status: CheckStatus;
  ready: boolean;
  serial: boolean;
  deviceKind?: MobileDeviceKind;
  deviceId?: string;
  detail: TranslatableText;
  verifiedAt?: string;
  config: TargetConfig;
}
export type TestTargetInfo = Omit<TestTarget, "config">;

export interface VerificationResult {
  target: string;
  status: "passed";
  durationMs: number;
  runtime: Record<string, unknown>;
}
