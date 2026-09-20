import type { DoctorCheck, TargetDeviceOption } from "../../../config/types.js";
import type { WorkbenchState } from "../../../setup/workbench-types.js";
import { localized, translator } from "../core/translator.js";

const t = translator.t.bind(translator);

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
        label: t("checklist.ios.tools.label"),
        detail: !xcodeReady
          ? t("checklist.ios.tools.installXcode")
          : driver?.status !== "completed"
            ? t("checklist.ios.tools.installDriver")
            : t("checklist.ios.tools.ready"),
        href: xcodeReady ? "/setup#environment-setup" : "#ios-mac-setup",
        ready: toolsReady,
        troubleshooting: [{ text: t("checklist.ios.tools.hintOpen") }, { text: t("checklist.ios.tools.hintDriver") }],
      },
      {
        id: "device",
        label: t("checklist.ios.device.label"),
        detail: connectionReady
          ? t("checklist.ios.device.ready")
          : nextConnectionCheck
            ? localized(nextConnectionCheck, "detail")
            : t("checklist.ios.device.connect"),
        href: "#ios-device-connection",
        ready: connectionReady,
        troubleshooting: [
          { text: t("checklist.ios.device.hintCable") },
          { text: t("checklist.ios.device.hintXcode") },
          { text: t("checklist.ios.device.hintDeveloperMode") },
        ],
      },
      {
        id: "access",
        label: t("checklist.ios.access.label"),
        detail: !signingReady
          ? setupCheck("signing")
            ? localized(setupCheck("signing")!, "detail")
            : t("checklist.ios.access.createSigning")
          : safariSettingsConfirmed
            ? t("checklist.ios.access.ready")
            : t("checklist.ios.access.enable"),
        href: signingReady ? "#ios-safari-settings" : "#ios-signing",
        ready: accessReady,
        manual: signingReady && !safariSettingsConfirmed,
        troubleshooting: signingReady
          ? [{ text: t("checklist.ios.access.hintSettings") }, { text: t("checklist.ios.access.hintAutomation") }]
          : [
              {
                text: t("checklist.ios.access.hintKeychain"),
              },
              {
                text: t("checklist.ios.access.hintCertificate"),
                href: "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer",
                linkLabel: t("checklist.ios.access.downloadCertificate"),
              },
            ],
      },
      {
        id: "test",
        label: t("checklist.ios.test.label"),
        detail: verified ? t("checklist.ios.test.ready") : t("checklist.ios.test.run"),
        href: verified ? "/targets" : "#ios-signing",
        ready: verified,
        troubleshooting: [
          { text: t("checklist.ios.test.hintUnlock") },
          {
            text: t("checklist.ios.test.hintTrust"),
          },
          { text: t("checklist.ios.test.hintExpiry") },
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
        label: t("checklist.android.tools.label"),
        detail: !sdkReady
          ? t("checklist.android.tools.installSdk")
          : driver?.status !== "completed"
            ? t("checklist.android.tools.installDriver")
            : t("checklist.android.tools.ready"),
        href: sdkReady ? "/setup#environment-setup" : "#android-tools",
        ready: toolsReady,
        troubleshooting: [
          { text: t("checklist.android.tools.hintSdk") },
          { text: t("checklist.android.tools.hintDriver") },
        ],
      },
      {
        id: "device",
        label: t("checklist.android.device.label"),
        detail: connected
          ? t("checklist.android.device.detected", { deviceName: device!.name })
          : t("checklist.android.device.connect"),
        href: "#android-device-connection",
        ready: connected,
        troubleshooting: [
          { text: t("checklist.android.device.hintDeveloperOptions") },
          { text: t("checklist.android.device.hintCable") },
        ],
      },
      {
        id: "access",
        label: t("checklist.android.access.label"),
        detail: !authorized
          ? check?.action
            ? localized(check, "action")
            : t("checklist.android.access.authorize")
          : chromeReady
            ? t("checklist.android.access.ready")
            : device?.detail
              ? localized(device, "detail")
              : t("checklist.android.access.installChrome"),
        href: "#android-debugging",
        ready: authorized && chromeReady,
        troubleshooting: [
          { text: t("checklist.android.access.hintReconnect") },
          { text: t("checklist.android.access.hintAuthorization") },
          { text: t("checklist.android.access.hintChrome") },
        ],
      },
      {
        id: "test",
        label: t("checklist.android.test.label"),
        detail: verified ? t("checklist.android.test.ready") : t("checklist.android.test.run"),
        href: "/targets",
        ready: verified,
        troubleshooting: [
          { text: t("checklist.android.test.hintUnlock") },
          { text: t("checklist.android.test.hintPrompt") },
        ],
      },
    ];
  }
}
