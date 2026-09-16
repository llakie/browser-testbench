import { afterEach, describe, expect, it, vi } from "vitest";
import { IosSimulatorCleanup } from "../../src/automation/ios-simulator-cleanup.js";
import type { TargetConfig } from "../../src/config/types.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("IosSimulatorCleanup", () => {
  afterEach(() => vi.restoreAllMocks());

  it.runIf(process.platform === "darwin")("terminates WebDriverAgent and closes the last simulator", async () => {
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ devices: { ios: [{ state: "Shutdown" }] } }),
        stderr: "",
      });

    await IosSimulatorCleanup.run(target());

    expect(run).toHaveBeenNthCalledWith(
      1,
      "xcrun",
      ["simctl", "terminate", "SIMULATOR-ID", "com.facebook.WebDriverAgentRunner.xctrunner"],
      { timeoutMs: 10_000 },
    );
    expect(run).toHaveBeenCalledWith("pkill", ["-f", "WebDriverAgent.xcodeproj.*SIMULATOR-ID"], {
      timeoutMs: 10_000,
    });
    expect(run).toHaveBeenLastCalledWith("pkill", ["-x", "Simulator"], { timeoutMs: 10_000 });
  });

  it.runIf(process.platform === "darwin")("keeps the Simulator app open while another device is booted", async () => {
    const run = vi.spyOn(CommandRunner, "run").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    run
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ devices: { ios: [{ state: "Booted" }] } }),
        stderr: "",
      });

    await IosSimulatorCleanup.run(target());

    expect(run).toHaveBeenCalledTimes(4);
  });
});

function target(): TargetConfig {
  return {
    name: "safari-ios",
    udid: "SIMULATOR-ID",
  };
}
