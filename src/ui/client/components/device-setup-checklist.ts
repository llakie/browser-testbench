import { defineComponent, type PropType } from "vue";
import type { DoctorCheck, TargetDeviceOption } from "../../../config/types.js";
import type { WorkbenchState } from "../../../setup/workbench-types.js";
import { DocumentationDisclosure } from "../core/documentation-disclosure.js";
import { workbenchStore } from "../stores/workbench-store.js";

const IOS_SAFARI_CONFIRMATION_KEY = "browser-testbench-ios-safari-settings";

interface ChecklistStep {
  id: string;
  label: string;
  detail: string;
  href: string;
  ready: boolean;
  manual?: boolean;
  troubleshooting?: ChecklistHint[];
}

interface ChecklistHint {
  text: string;
  href?: string;
  linkLabel?: string;
}

type ChecklistPlatform = "ios" | "android";
type ChecklistStatus = "complete" | "attention" | "pending" | "manual";

export const DeviceSetupChecklist = defineComponent({
  template: "#device-setup-checklist-template",
  props: {
    platform: { type: String as PropType<ChecklistPlatform>, required: true },
  },
  data: () => ({
    store: workbenchStore,
    iosSafariSettingsConfirmed: false,
  }),
  computed: {
    workbench(): WorkbenchState | null {
      return this.store.workbench;
    },
    isIos(): boolean {
      return this.platform === "ios";
    },
    elementId(): string {
      return `${this.platform}-setup-checklist`;
    },
    heading(): string {
      return this.isIos ? "Set up your iPhone or iPad" : "Set up your Android device";
    },
    intro(): string {
      return this.workbench
        ? `We show one step at a time for ${this.device?.name ?? "your device"}.`
        : "Checking this Testbench and connected devices …";
    },
    completionText(): string {
      return this.isIos ? "This device is ready for Safari testing." : "This device is ready for Chrome testing.";
    },
    check(): DoctorCheck | undefined {
      const id = this.isIos ? "safari-ios" : "chrome-android";
      return this.workbench?.checks.find((check) => check.id === id);
    },
    device(): TargetDeviceOption | undefined {
      return this.check?.devices?.find((device) => device.deviceKind === "physical");
    },
    deviceId(): string {
      return this.device?.id ?? "unconnected";
    },
    steps(): ChecklistStep[] {
      return this.isIos ? this.iosSteps() : this.androidSteps();
    },
    completedSteps(): ChecklistStep[] {
      return this.steps.filter((step) => step.ready);
    },
    currentStep(): ChecklistStep | undefined {
      return this.steps.find((step) => !step.ready);
    },
    laterSteps(): ChecklistStep[] {
      const currentIndex = this.steps.findIndex((step) => !step.ready);
      return currentIndex < 0 ? [] : this.steps.slice(currentIndex + 1).filter((step) => !step.ready);
    },
  },
  watch: {
    deviceId: {
      immediate: true,
      handler(deviceId: string): void {
        if (!this.isIos) return;
        this.iosSafariSettingsConfirmed = localStorage.getItem(`${IOS_SAFARI_CONFIRMATION_KEY}:${deviceId}`) === "true";
      },
    },
  },
  methods: {
    iosSteps(): ChecklistStep[] {
      const setupCheck = (id: string): { ready: boolean; detail: string } | undefined =>
        this.device?.setupChecks?.find((check) => check.id === id);
      const xcodeReady = Boolean(
        this.workbench?.platform === "darwin" &&
        this.check &&
        this.check.status !== "skip" &&
        !this.check.detail.includes("Xcode is not available"),
      );
      const driver = this.workbench?.actions.find((action) => action.label === "Appium XCUITest");
      const toolsReady = xcodeReady && driver?.status === "completed";
      const connectionChecks = [setupCheck("usb"), setupCheck("trust"), setupCheck("developer-mode")];
      const connectionReady = connectionChecks.every((check) => check?.ready === true);
      const nextConnectionCheck = connectionChecks.find((check) => check?.ready !== true);
      const signingReady = setupCheck("signing")?.ready === true;
      const accessReady = signingReady && this.iosSafariSettingsConfirmed;
      const verified = this.workbench?.testTargets.some(
        (target) => target.browser === "safari-ios" && target.deviceKind === "physical" && target.verifiedAt,
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
            : this.iosSafariSettingsConfirmed
              ? "Signing and the Safari automation settings are ready."
              : "Enable UI Automation, Web Inspector, and Remote Automation, then confirm below.",
          href: signingReady ? "#ios-safari-settings" : "#ios-signing",
          ready: accessReady,
          manual: signingReady && !this.iosSafariSettingsConfirmed,
          troubleshooting: signingReady
            ? [
                {
                  text: "On iOS 16, Safari is directly under Settings; newer versions place it under Settings → Apps.",
                },
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
          ready: Boolean(verified),
          troubleshooting: [
            { text: "Keep the iPhone unlocked while WebDriverAgent starts for the first time." },
            {
              text: "If iOS blocks WebDriverAgent, trust the Apple Account under Settings → General → VPN & Device Management.",
            },
            { text: "A free Personal Team profile expires after seven days and must then be signed again." },
          ],
        },
      ];
    },
    androidSteps(): ChecklistStep[] {
      const driver = this.workbench?.actions.find((action) => action.label === "Appium UiAutomator2");
      const sdkReady = Boolean(this.check && !this.check.detail.includes("Android SDK not found"));
      const toolsReady = sdkReady && driver?.status === "completed";
      const connected = Boolean(this.device);
      const authorized = this.device?.state === "Connected";
      const chromeReady = this.device?.compatible === true;
      const verified = this.workbench?.testTargets.some(
        (target) => target.browser === "chrome-android" && target.deviceKind === "physical" && target.verifiedAt,
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
            ? `${this.device!.name} was detected over USB.`
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
            ? (this.check?.action ?? "Accept the USB debugging prompt on the device.")
            : chromeReady
              ? "USB debugging is authorized and Chrome is available."
              : (this.device?.detail ?? "Install or enable Google Chrome on the device."),
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
          ready: Boolean(verified),
          troubleshooting: [
            { text: "Keep the device unlocked during the first Appium session." },
            { text: "Accept any additional debugging prompt shown by Android." },
          ],
        },
      ];
    },
    status(step: ChecklistStep): ChecklistStatus {
      if (step.ready) return "complete";
      if (step.id !== this.currentStep?.id) return "pending";
      return step.manual ? "manual" : "attention";
    },
    stepNumber(step: ChecklistStep): number {
      return this.steps.findIndex((candidate) => candidate.id === step.id) + 1;
    },
    statusIcon(status: ChecklistStatus): string {
      return {
        complete: "fa-check",
        attention: "fa-arrow-right",
        pending: "fa-clock",
        manual: "fa-hand-pointer",
      }[status];
    },
    statusLabel(status: ChecklistStatus): string {
      return {
        complete: "Done",
        attention: "Next step",
        pending: "Later",
        manual: "Confirm once",
      }[status];
    },
    confirmManualStep(confirmed: boolean): void {
      if (!this.isIos) return;
      this.iosSafariSettingsConfirmed = confirmed;
      localStorage.setItem(`${IOS_SAFARI_CONFIRMATION_KEY}:${this.deviceId}`, String(confirmed));
    },
    refresh(): void {
      void this.store.refresh({ analyze: true });
    },
    openInstructions(href: string): void {
      DocumentationDisclosure.openTarget(href);
    },
  },
});
