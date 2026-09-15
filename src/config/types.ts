import type { BrowserHandle } from "../automation/browser-session.js";
import type { GestureExecution } from "../automation/mobile-gestures.js";
import type { GestureRequest } from "./input-schemas.js";

export const TARGET_NAMES = ["chrome", "firefox", "safari", "edge", "safari-ios", "chrome-android"] as const;

export type TargetName = (typeof TARGET_NAMES)[number];
export type TargetKind = "desktop" | "mobile";
export type CheckStatus = "ready" | "action" | "blocked" | "skip";
export type TargetPolicy = "available" | "strict";

export interface TargetConfig {
  name: TargetName;
  enabled?: boolean;
  headless?: boolean;
  deviceName?: string;
  platformVersion?: string;
  avd?: string;
  udid?: string;
  downloadDir?: string;
  recordVideo?: boolean;
  capabilities?: Record<string, unknown>;
}

export interface TestbenchConfig {
  name: string;
  baseUrl: string;
  targetPolicy?: TargetPolicy;
  targets: Array<TargetName | TargetConfig>;
  specs?: string[];
  artifactsDir?: string;
  timeoutMs?: number;
  maxDesktopWorkers?: number;
  failFast?: boolean;
}

export interface NormalizedConfig extends Omit<TestbenchConfig, "targets"> {
  configDir: string;
  targets: TargetConfig[];
  artifactsDir: string;
  timeoutMs: number;
  maxDesktopWorkers: number;
  failFast: boolean;
  targetPolicy: TargetPolicy;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  action?: string;
  commands?: string[];
  devices?: TargetDeviceOption[];
}

export interface TargetDeviceOption {
  id: string;
  name: string;
  platformVersion?: string;
  state?: string;
  compatible: boolean;
  config: TargetConfig;
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
  label: string;
  kind: TargetKind;
  status: CheckStatus;
  ready: boolean;
  serial: boolean;
  detail: string;
  config: TargetConfig;
}
export type TestTargetInfo = Omit<TestTarget, "config">;

export interface TestStepContext {
  browser: BrowserHandle;
  baseUrl: string;
  target: TargetConfig;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  screenshot(name?: string): Promise<string>;
  gesture(input: GestureRequest): Promise<GestureExecution>;
}

export interface TestCase {
  name: string;
  skipTargets?: TargetName[];
  onlyTargets?: TargetName[];
  run(context: TestStepContext): Promise<void>;
}

export interface TestModule {
  tests: TestCase[];
}

export interface TestResult {
  name: string;
  target: TargetName;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  artifacts: string[];
}

export interface TargetRunResult {
  target: TargetName;
  status: "passed" | "failed" | "unavailable";
  durationMs: number;
  tests: TestResult[];
  error?: string;
  runtime?: Record<string, unknown>;
  artifacts?: string[];
}

export interface RunSummary {
  id: string;
  name: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  baseUrl: string;
  artifactDir: string;
  targets: TargetRunResult[];
}

export interface TestbenchEvent {
  type: string;
  timestamp: string;
  runId?: string;
  sessionId?: string;
  target?: TargetName;
  test?: string;
  data?: Record<string, unknown>;
}
