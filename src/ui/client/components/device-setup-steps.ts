import type { DoctorCheck, TargetDeviceOption } from "../../../config/types.js";
import type { WorkbenchState } from "../../../setup/workbench-types.js";

export interface ChecklistHint {
  text: string;
  href?: string;
  linkLabel?: string;
}

export interface ChecklistStep {
  id: string;
  label: string;
  detail: string;
  href: string;
  ready: boolean;
  manual?: boolean;
  troubleshooting?: ChecklistHint[];
}

export class DeviceSetupSteps {
  static ios(
    workbench: WorkbenchState,
    check: DoctorCheck | undefined,
    device: TargetDeviceOption | undefined,
    safariSettingsConfirmed: boolean,
  ): ChecklistStep[] {
    const setupCheck = (id: "usb" | "trust" | "developer-mode" | "signing") =>
      device?.setupChecks?.find((candidate) => candidate.id === id);
    const xcodeReady = Boolean(
      workbench.platform === "darwin" && check && check.status !== "blocked" && check.status !== "skip",
    );
    const driver = workbench.actions.find((action) => action.id === "appium-xcuitest");
    const toolsReady = xcodeReady && driver?.status === "completed";
    const connectionChecks = [setupCheck("usb"), setupCheck("trust"), setupCheck("developer-mode")];
    const connectionReady = connectionChecks.every((candidate) => candidate?.ready === true);
    const nextConnectionCheck = connectionChecks.find((candidate) => candidate?.ready !== true);
    const signingReady = setupCheck("signing")?.ready === true;
    const accessReady = signingReady && safariSettingsConfirmed;
    const verified = workbench.testTargets.some(
      (target) =>
        target.browser === "safari-ios" &&
        target.deviceKind === "physical" &&
        target.deviceId === device?.id &&
        Boolean(target.verifiedAt),
    );

    return [
      {
        id: "tools",
        label: "Install Xcode and the iOS test tools",
        detail: !xcodeReady
          ? "Install Xcode and open it once."
          : driver?.status !== "completed"
            ? "Install Appium XCUITest under Environment setup."
            : "Xcode and Appium XCUITest are ready.",
        href: xcodeReady ? "/setup#environment-setup" : "#ios-mac-setup",
        ready: toolsReady,
        troubleshooting: [
          { text: "Open Xcode once and accept its license or component installation prompts." },
          { text: "No separate iPhone driver is required; install Appium XCUITest from Environment setup." },
        ],
      },
      {
        id: "device",
        label: "Connect and trust the device",
        detail: connectionReady
          ? "The device is connected, trusted, and in Developer Mode."
          : (nextConnectionCheck?.detail ?? "Connect and unlock the device by USB."),
        href: "#ios-device-connection",
        ready: connectionReady,
        troubleshooting: [
          { text: "Use a data-capable USB cable and keep the device unlocked." },
          { text: "In Xcode, open Window → Devices and Simulators and wait until the warning disappears." },
          { text: "Developer Mode requires a restart and a second confirmation after the restart." },
        ],
      },
      {
        id: "access",
        label: "Allow browser automation",
        detail: !signingReady
          ? (setupCheck("signing")?.detail ?? "Create an Apple Development signing identity in Xcode.")
          : safariSettingsConfirmed
            ? "Signing and the Safari automation settings are ready."
            : "Enable UI Automation, Web Inspector, and Remote Automation, then confirm below.",
        href: signingReady ? "#ios-safari-settings" : "#ios-signing",
        ready: accessReady,
        manual: signingReady && !safariSettingsConfirmed,
        troubleshooting: signingReady
          ? [
              { text: "On iOS 16, Safari is directly under Settings; newer versions place it under Settings → Apps." },
              { text: "UI Automation appears under Settings → Developer after Developer Mode is enabled." },
            ]
          : [
              {
                text: "In Keychain Access select login → My Certificates and expand Apple Development. A private key must appear below it.",
              },
              {
                text: "If the identity remains invalid, install Apple's WWDR G3 intermediate certificate.",
                href: "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer",
                linkLabel: "Download WWDR G3",
              },
            ],
      },
      {
        id: "test",
        label: "Run the first Safari test",
        detail: verified
          ? "Browser Testbench has successfully controlled Safari on this device."
          : "Run the physical Safari target once to finish setup.",
        href: verified ? "/targets" : "#ios-signing",
        ready: verified,
        troubleshooting: [
          { text: "Keep the iPhone unlocked while WebDriverAgent starts for the first time." },
          {
            text: "If iOS blocks WebDriverAgent, trust the Apple Account under Settings → General → VPN & Device Management.",
          },
          { text: "A free Personal Team profile expires after seven days and must then be signed again." },
        ],
      },
    ];
  }

  static android(
    workbench: WorkbenchState,
    check: DoctorCheck | undefined,
    device: TargetDeviceOption | undefined,
  ): ChecklistStep[] {
    const driver = workbench.actions.find((action) => action.id === "appium-uiautomator2");
    const sdkReady = Boolean(check && check.status !== "blocked" && check.status !== "skip");
    const toolsReady = sdkReady && driver?.status === "completed";
    const connected = Boolean(device);
    const authorized = device?.state === "Connected";
    const chromeReady = device?.compatible === true;
    const verified = workbench.testTargets.some(
      (target) =>
        target.browser === "chrome-android" &&
        target.deviceKind === "physical" &&
        target.deviceId === device?.id &&
        Boolean(target.verifiedAt),
    );

    return [
      {
        id: "tools",
        label: "Install Android Platform Tools and Appium",
        detail: !sdkReady
          ? "Install Android Studio or the Android SDK Platform Tools."
          : driver?.status !== "completed"
            ? "Install Appium UiAutomator2 under Environment setup."
            : "Android Platform Tools and Appium UiAutomator2 are ready.",
        href: sdkReady ? "/setup#environment-setup" : "#android-tools",
        ready: toolsReady,
        troubleshooting: [
          { text: "Android Studio includes the required Platform Tools." },
          { text: "Install Appium UiAutomator2 from Environment setup." },
        ],
      },
      {
        id: "device",
        label: "Connect the device",
        detail: connected
          ? `${device!.name} was detected over USB.`
          : "Enable USB debugging, then connect and unlock the device.",
        href: "#android-device-connection",
        ready: connected,
        troubleshooting: [
          { text: "Enable Developer options by tapping the Android build number seven times." },
          { text: "Use a data-capable USB cable and keep the device unlocked." },
        ],
      },
      {
        id: "access",
        label: "Allow debugging and Chrome",
        detail: !authorized
          ? (check?.action ?? "Accept the USB debugging prompt on the device.")
          : chromeReady
            ? "USB debugging is authorized and Chrome is available."
            : (device?.detail ?? "Install or enable Google Chrome on the device."),
        href: "#android-debugging",
        ready: authorized && chromeReady,
        troubleshooting: [
          { text: "Reconnect the unlocked device if the USB debugging prompt does not appear." },
          { text: "If authorization is stuck, revoke USB debugging authorizations and connect again." },
          { text: "Install or enable Google Chrome before running the first test." },
        ],
      },
      {
        id: "test",
        label: "Run the first Chrome test",
        detail: verified
          ? "Browser Testbench has successfully controlled Chrome on this device."
          : "Run the physical Android target once to finish setup.",
        href: "/targets",
        ready: verified,
        troubleshooting: [
          { text: "Keep the device unlocked during the first Appium session." },
          { text: "Accept any additional debugging prompt shown by Android." },
        ],
      },
    ];
  }
}
