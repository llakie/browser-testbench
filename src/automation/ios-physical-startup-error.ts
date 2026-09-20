import type { TargetConfig } from "../config/types.js";

export class IosPhysicalStartupError {
  static isSafariDebuggerTimeout(error: unknown): boolean {
    return error instanceof Error && /remote Safari debugger did not respond/iu.test(error.message);
  }

  static hasTerminalDiagnostic(output: string): boolean {
    return /(iOS [\d.]+ is not installed|logic testing unavailable|invalid code signature|explicitly trusted|xcodebuild exited with code|\*\* TEST (?:BUILD|EXECUTE) FAILED \*\*)/iu.test(
      output,
    );
  }

  static from(error: unknown, target: TargetConfig, appiumOutput = ""): unknown {
    if (target.name !== "safari-ios" || target.deviceKind !== "physical" || !(error instanceof Error)) return error;

    const diagnostic = `${appiumOutput}\n${error.message}`;
    if (this.isSafariDebuggerTimeout(error)) {
      return new Error(
        `Safari started on ${target.deviceName ?? "the iOS device"}, but its Web Inspector did not respond. ` +
          `Browser Testbench retried the connection and cleaned up the failed session. Confirm that Web Inspector and ` +
          `Remote Automation are enabled under Safari's advanced settings, close obstructing Safari dialogs, and run the test again. ` +
          `Original error: ${error.message}`,
        { cause: error },
      );
    }
    const occupiedPort = diagnostic.match(/port #?(\d+) is occupied/iu)?.[1];
    if (occupiedPort) {
      return new Error(
        `WebDriverAgent cannot start because port ${occupiedPort} is still used by another process. ` +
          `Stop the previous iOS test or restart Browser Testbench, then run the test again. ` +
          `This is not a signing failure. Original error: ${error.message}`,
        { cause: error },
      );
    }

    const missingPlatform = diagnostic.match(/iOS ([\d.]+) is not installed/iu)?.[1];
    if (missingPlatform) {
      return new Error(
        `Xcode cannot use ${target.deviceName ?? "the iOS device"} because its iOS ${missingPlatform} platform component is not installed. ` +
          `Open Xcode → Settings → Components, install iOS ${missingPlatform}, wait for the installation to finish, and run the test again. ` +
          `This is not a signing failure. Original error: ${error.message}`,
        { cause: error },
      );
    }

    if (/invalid code signature|profile has not been explicitly trusted/iu.test(diagnostic)) {
      return new Error(
        `WebDriverAgent was built, signed, and installed on ${target.deviceName ?? "the iOS device"}, but iOS has not trusted the developer profile yet. ` +
          `On the device, open Settings → General → VPN & Device Management, select the developer entry for the Apple Account, ` +
          `choose Trust, and then run the test again. The device needs internet access for this confirmation. ` +
          `Original error: ${error.message}`,
        { cause: error },
      );
    }

    if (/logic testing unavailable/iu.test(diagnostic)) {
      return new Error(
        `Xcode cannot start WebDriverAgent on ${target.deviceName ?? "the iOS device"}. ` +
          `WebDriverAgent was built and signed, but this Xcode version cannot run its XCTest runner on this iOS version ` +
          `(Logic Testing Unavailable). This is an Xcode compatibility problem, not a signing failure. ` +
          `For an iOS 16 device, select Xcode 26.2 and run the test again. Original error: ${error.message}`,
        { cause: error },
      );
    }

    if (
      !/(no provisioning profile|requires? a development team|code sign(?:ing)?|codesign|signing certificate|no apple development|provisioning profile[^\n]*(?:not found|missing)|development team[^\n]*(?:required|missing))/iu.test(
        diagnostic,
      )
    )
      return error;
    return new Error(
      `WebDriverAgent could not be signed or installed on ${target.deviceName ?? "the iOS device"}. ` +
        `Open the Setup page and complete the WebDriverAgent signing step. Paid Developer teams can provision automatically. ` +
        `For a free Personal Team, open the WDA project in Xcode, select the team for WebDriverAgentRunner, enable automatic signing, ` +
        `use bundle ID '${target.wdaBundleId ?? "the bundle ID shown by Browser Testbench"}', and run it once on the connected device. ` +
        `Free profiles expire after seven days and then need to be rebuilt. Original error: ${error.message}`,
      { cause: error },
    );
  }
}
