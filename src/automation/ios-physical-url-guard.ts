import type { TargetConfig } from "../config/types.js";
import { NetworkUrl } from "../infrastructure/network-url.js";
import { RemoteUrlGuard } from "../remote/remote-url-guard.js";

export class IosPhysicalLoopbackUrlError extends Error {}

export class IosPhysicalUrlGuard {
  static assertReachable(value: string | undefined, target: TargetConfig): void {
    if (!value || target.name !== "safari-ios" || target.deviceKind !== "physical") return;
    const url = new URL(value);
    if (!NetworkUrl.isLoopbackHostname(url.hostname)) return;
    const address = RemoteUrlGuard.lanAddress();
    const suggestion = address
      ? ` If the application runs on the Testbench computer, use '${NetworkUrl.withHostname(value, address)}'.`
      : "";
    throw new IosPhysicalLoopbackUrlError(
      `Safari on a physical iOS device cannot reach '${value}' because loopback refers to the device itself. Bind the application to a LAN interface and use the reachable LAN address or hostname of the computer that runs it.${suggestion}`,
    );
  }

  static fixtureUrl(value: string): string {
    const address = RemoteUrlGuard.lanAddress();
    if (!address) {
      throw new IosPhysicalLoopbackUrlError(
        "A LAN address is required to verify Safari on a physical iOS device. Connect the Mac and device to the same network.",
      );
    }
    return NetworkUrl.withHostname(value, address);
  }
}
