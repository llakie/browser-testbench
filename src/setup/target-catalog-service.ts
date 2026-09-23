import { TargetRegistry } from "../config/target-registry.js";
import { TestbenchDefaults } from "../config/defaults.js";
import {
  TARGET_NAMES,
  type DoctorCheck,
  type TargetDeviceOption,
  type TestTarget,
  type TestTargetInfo,
} from "../config/types.js";
import { DoctorService } from "./doctor-service.js";
import { VerificationStore } from "./verification-store.js";
import type { StartSessionInput } from "../config/input-schemas.js";
import { IosPhysicalUrlGuard } from "../automation/ios-physical-url-guard.js";
import { LocalizedError } from "../i18n/translator.js";

export class UnknownTargetError extends LocalizedError {
  constructor(id: string) {
    super({ key: "errors.unknownTarget", parameters: { targetId: id } }, 404);
    this.name = "UnknownTargetError";
  }
}

export class TargetCatalogService {
  private static cached?: { expiresAt: number; targets: TestTarget[] };

  static invalidate(): void {
    this.cached = undefined;
  }

  static async list(options: { refresh?: boolean } = {}): Promise<TestTarget[]> {
    if (!options.refresh && this.cached && this.cached.expiresAt > Date.now()) return this.cached.targets;
    const checks = await DoctorService.inspect([...TARGET_NAMES]);
    return this.update(checks);
  }

  static async resolve(id: string): Promise<TestTarget> {
    const current = (await this.list()).find((target) => target.id === id);
    if (current) return current;
    const refreshed = (await this.list({ refresh: true })).find((target) => target.id === id);
    if (refreshed) return refreshed;
    throw new UnknownTargetError(id);
  }

  static async publicList(options: { refresh?: boolean } = {}): Promise<TestTargetInfo[]> {
    return this.toPublic(await this.list(options));
  }

  static update(checks: DoctorCheck[]): TestTarget[] {
    const targets = this.build(checks);
    this.cached = { expiresAt: Date.now() + TestbenchDefaults.TARGET_CACHE_TTL_MS, targets };
    return targets;
  }

  static async toPublic(targets: TestTarget[]): Promise<TestTargetInfo[]> {
    return Promise.all(
      targets.map(async ({ config: _config, ...target }) => ({
        ...target,
        verifiedAt: (await VerificationStore.read(target.id))?.verifiedAt,
      })),
    );
  }

  static async sessionOptions(input: StartSessionInput) {
    const target = await this.resolve(input.target);
    IosPhysicalUrlGuard.assertReachable(input.url, target.config);
    return {
      target,
      options: {
        ...target.config,
        ...input,
        target: target.browser,
        targetId: target.id,
        ...(target.kind === "mobile" ? { headless: undefined } : {}),
      },
    };
  }

  static build(checks: DoctorCheck[]): TestTarget[] {
    return TARGET_NAMES.flatMap((browser) => {
      const definition = TargetRegistry.definitions[browser];
      const check = checks.find((candidate) => candidate.id === browser);
      if (!check) return [];
      if (definition.kind === "desktop") {
        return [
          {
            id: browser,
            browser,
            label: definition.label,
            kind: definition.kind,
            status: check.status,
            ready: check.status === "ready",
            serial: definition.serial,
            detail: check.detail,
            config: { name: browser },
          },
        ];
      }
      if (browser === "safari-ios" || browser === "chrome-android") {
        return this.mobileTargets(browser, check.devices?.filter((device) => device.compatible) ?? [], check);
      }
      return [];
    });
  }

  private static mobileTargets(
    browser: "safari-ios" | "chrome-android",
    devices: TargetDeviceOption[],
    check: DoctorCheck,
  ): TestTarget[] {
    const candidates = devices
      .map((device) => ({ device, baseId: this.mobileId(browser, device) }))
      .sort((left, right) => left.baseId.localeCompare(right.baseId) || left.device.id.localeCompare(right.device.id));
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate.baseId, (counts.get(candidate.baseId) ?? 0) + 1);
    const positions = new Map<string, number>();
    return candidates.map(({ device, baseId }) => {
      const position = positions.get(baseId) ?? 0;
      positions.set(baseId, position + 1);
      const id = counts.get(baseId)! > 1 ? `${baseId}-${this.alphaSuffix(position)}` : baseId;
      return {
        id,
        browser,
        label: {
          key: this.mobileLabelKey(browser, device),
          parameters: { deviceName: device.name, version: device.platformVersion ?? "" },
        },
        kind: "mobile",
        status: check.status,
        ready: check.status === "ready",
        serial: true,
        deviceKind: device.deviceKind,
        deviceId: device.id,
        detail: check.detail,
        config: { ...device.config },
      };
    });
  }

  private static mobileId(browser: "safari-ios" | "chrome-android", device: TargetDeviceOption): string {
    const name = this.slug(device.name);
    const version = device.platformVersion ? this.slug(device.platformVersion) : "";
    const devicePart = version && !name.endsWith(`-${version}`) ? `${name}-${version}` : name;
    return `${browser}-${devicePart}`;
  }

  private static mobileLabelKey(browser: "safari-ios" | "chrome-android", device: TargetDeviceOption) {
    const suffix = device.platformVersion ? "" : "NoVersion";
    if (browser === "safari-ios")
      return device.deviceKind === "physical"
        ? (`targets.mobileLabel.safariPhysical${suffix}` as const)
        : (`targets.mobileLabel.safari${suffix}` as const);
    if (device.deviceKind === "physical") return `targets.mobileLabel.androidPhysical${suffix}` as const;
    if (device.deviceKind === "emulator") return `targets.mobileLabel.androidEmulator${suffix}` as const;
    return `targets.mobileLabel.android${suffix}` as const;
  }

  private static slug(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
  }

  private static alphaSuffix(index: number): string {
    let value = index + 1;
    let result = "";
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(97 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }
}
