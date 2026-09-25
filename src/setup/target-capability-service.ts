import type { TestTarget } from "../config/types.js";
import { TestbenchDefaults } from "../config/defaults.js";
import { TestbenchError } from "../errors/testbench-error.js";

export interface FeatureCapabilities {
  limits: { requestBytes: number; assetBytes: number; sessionAssetBytes: number };
  permissions: { native: string[]; origin: string[] };
  localOrigins: { reverse: boolean };
  mediaInjection: { cameraImage: boolean };
  recording: {
    screen: boolean;
    viewport: boolean;
    explicitLifecycle: boolean;
    pauseResume: boolean;
    geometry: boolean;
    marks: boolean;
  };
  screenshots: { screen: boolean; viewport: boolean; fullPage: boolean; element: boolean };
}

export type CapabilityRequirement = Record<string, unknown>;

export class TargetCapabilityService {
  static for(target: Pick<TestTarget, "browser" | "kind" | "deviceKind">): FeatureCapabilities {
    const android = target.browser === "chrome-android";
    const chromium = android || target.browser === "chrome" || target.browser === "edge";
    const mobile = target.kind === "mobile";
    return {
      limits: {
        requestBytes: TestbenchDefaults.REQUEST_BODY_LIMIT_BYTES,
        assetBytes: TestbenchDefaults.ASSET_LIMIT_BYTES,
        sessionAssetBytes: TestbenchDefaults.SESSION_ASSET_TOTAL_LIMIT_BYTES,
      },
      permissions: {
        native: android ? ["camera", "microphone"] : [],
        origin: chromium ? ["camera", "microphone", "geolocation", "notifications"] : [],
      },
      localOrigins: { reverse: android },
      mediaInjection: { cameraImage: android && target.deviceKind === "emulator" },
      recording: {
        screen: mobile,
        viewport: false,
        explicitLifecycle: false,
        pauseResume: false,
        geometry: false,
        marks: true,
      },
      screenshots: { screen: false, viewport: true, fullPage: !android, element: true },
    };
  }

  static assert(requirement: CapabilityRequirement | undefined, available: FeatureCapabilities, target: string): void {
    if (!requirement) return;
    const missing = this.missing(requirement, available);
    if (missing.length === 0) return;
    throw new TestbenchError("CAPABILITY_UNAVAILABLE", `Target '${target}' does not provide required capabilities.`, {
      operation: "capability.require",
      status: 409,
      details: { target, requested: requirement, available, missing },
    });
  }

  static missing(requirement: CapabilityRequirement, available: FeatureCapabilities): string[] {
    const missing: string[] = [];
    this.compare(requirement, available as unknown as Record<string, unknown>, "", missing);
    return missing;
  }

  private static compare(
    requested: Record<string, unknown>,
    available: Record<string, unknown>,
    prefix: string,
    missing: string[],
  ): void {
    for (const [key, expected] of Object.entries(requested)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const actual = available[key];
      if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || expected.some((value) => !actual.includes(value))) missing.push(path);
      } else if (expected && typeof expected === "object") {
        if (!actual || typeof actual !== "object" || Array.isArray(actual)) missing.push(path);
        else this.compare(expected as Record<string, unknown>, actual as Record<string, unknown>, path, missing);
      } else if (actual !== expected) missing.push(path);
    }
  }
}
