import { describe, expect, it } from "vitest";
import type { DoctorCheck, TargetDeviceOption } from "../../src/config/types.js";
import { TargetCatalogService } from "../../src/setup/target-catalog-service.js";

describe("TargetCatalogService", () => {
  it("creates readable IDs for desktop browsers and concrete mobile devices", () => {
    const targets = TargetCatalogService.build([
      check("chrome", "ready"),
      check("safari-ios", "ready", [
        device("simulator-one", "iPhone 17 Pro", "26.5", {
          name: "safari-ios",
          deviceName: "iPhone 17 Pro",
          platformVersion: "26.5",
          udid: "simulator-one",
        }),
      ]),
      check("chrome-android", "ready", [
        device("emulator-5554", "Browser Testbench API 36", "36", {
          name: "chrome-android",
          avd: "Browser_Testbench_API_36",
        }),
      ]),
    ]);

    expect(targets.map((target) => target.id)).toEqual([
      "chrome",
      "safari-ios-iphone-17-pro-26-5",
      "chrome-android-browser-testbench-api-36",
    ]);
  });

  it("uses deterministic alphabetic suffixes when readable IDs collide", () => {
    const targets = TargetCatalogService.build([
      check("safari-ios", "ready", [
        device("b", "iPhone 17 Pro", "26.5", { name: "safari-ios", udid: "b" }),
        device("a", "iPhone 17 Pro", "26.5", { name: "safari-ios", udid: "a" }),
      ]),
    ]);

    expect(targets.map((target) => target.id)).toEqual([
      "safari-ios-iphone-17-pro-26-5-a",
      "safari-ios-iphone-17-pro-26-5-b",
    ]);
    expect(targets.map((target) => target.config.udid)).toEqual(["a", "b"]);
  });
});

function check(id: string, status: DoctorCheck["status"], devices?: TargetDeviceOption[]): DoctorCheck {
  return { id, label: id, status, detail: `${id} detail`, devices };
}

function device(
  id: string,
  name: string,
  platformVersion: string,
  config: TargetDeviceOption["config"],
): TargetDeviceOption {
  return { id, name, platformVersion, state: "Shutdown", compatible: true, config };
}
