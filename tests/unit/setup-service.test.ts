import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { SetupService } from "../../src/setup/setup-service.js";

describe("SetupService Appium status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports installed mobile drivers with their versions", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        xcuitest: { installed: true, version: "12.12.4" },
        uiautomator2: { installed: true, version: "8.7.0" },
      }),
    });

    await expect(SetupService.appiumDriverStatus(["safari-ios", "chrome-android"])).resolves.toEqual([
      { name: "xcuitest", installed: true, version: "12.12.4" },
      { name: "uiautomator2", installed: true, version: "8.7.0" },
    ]);
  });

  it("reports a driver as missing when Appium cannot list it", async () => {
    vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 1, stdout: "", stderr: "not installed" });

    await expect(SetupService.appiumDriverStatus(["safari-ios"])).resolves.toEqual([
      { name: "xcuitest", installed: false, version: undefined },
    ]);
  });
});
