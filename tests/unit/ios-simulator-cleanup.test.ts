import { afterEach, describe, expect, it, vi } from "vitest";
import { IosSessionCleanup } from "../../src/automation/ios-session-cleanup.js";
import type { TargetConfig } from "../../src/config/types.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("IosSessionCleanup", () => {
  it.runIf(process.platform === "darwin")("stops WebDriverAgent for a physical iOS device", async () => {
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });

    await IosSessionCleanup.run({
      name: "safari-ios",
      deviceKind: "physical",
      udid: "00008140-DEVICE",
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, "pkill", ["-f", "WebDriverAgent.xcodeproj.*00008140-DEVICE"], {
      timeoutMs: 10_000,
    });
    expect(run).toHaveBeenNthCalledWith(2, "pgrep", ["-f", "WebDriverAgent.xcodeproj.*00008140-DEVICE"], {
      timeoutMs: 10_000,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.runIf(process.platform === "darwin")("terminates WebDriverAgent and closes the last simulator", async () => {
    const run = vi
      .spyOn(CommandRunner, "run")
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ devices: { ios: [{ state: "Shutdown" }] } }),
        stderr: "",
      });

    await IosSessionCleanup.run(target());

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
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ devices: { ios: [{ state: "Booted" }] } }),
        stderr: "",
      });

    await IosSessionCleanup.run(target());

    expect(run).toHaveBeenCalledTimes(5);
  });
});

function target(): TargetConfig {
  return {
    name: "safari-ios",
    udid: "SIMULATOR-ID",
  };
}
