import { defineComponent, type PropType } from "vue";
import type { DoctorCheck, TargetDeviceOption } from "../../../config/types.js";
import type { WorkbenchState } from "../../../setup/workbench-types.js";
import { DocumentationDisclosure } from "../core/documentation-disclosure.js";
import { workbenchStore } from "../stores/workbench-store.js";
import { DeviceSetupSteps, type ChecklistStep } from "./device-setup-steps.js";

const IOS_SAFARI_CONFIRMATION_KEY = "browser-testbench-ios-safari-settings";

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
    selectedDeviceId: "",
    visibilityObserver: undefined as IntersectionObserver | undefined,
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
      return this.physicalDevices.find((device) => device.id === this.selectedDeviceId) ?? this.physicalDevices[0];
    },
    physicalDevices(): TargetDeviceOption[] {
      return this.check?.devices?.filter((device) => device.deviceKind === "physical") ?? [];
    },
    physicalDeviceIds(): string {
      return this.physicalDevices.map((device) => device.id).join("\n");
    },
    deviceId(): string {
      return this.device?.id ?? "unconnected";
    },
    steps(): ChecklistStep[] {
      if (!this.workbench) return [];
      return this.isIos
        ? DeviceSetupSteps.ios(this.workbench, this.check, this.device, this.iosSafariSettingsConfirmed)
        : DeviceSetupSteps.android(this.workbench, this.check, this.device);
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
    physicalDeviceIds: {
      immediate: true,
      handler(): void {
        if (!this.physicalDevices.some((device) => device.id === this.selectedDeviceId)) {
          this.selectedDeviceId = this.physicalDevices[0]?.id ?? "";
        }
      },
    },
    deviceId: {
      immediate: true,
      handler(deviceId: string): void {
        if (!this.isIos) return;
        this.iosSafariSettingsConfirmed = localStorage.getItem(`${IOS_SAFARI_CONFIRMATION_KEY}:${deviceId}`) === "true";
      },
    },
  },
  mounted(): void {
    if (!("IntersectionObserver" in window)) {
      void this.store.enableWorkbench();
      return;
    }
    this.visibilityObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      this.visibilityObserver?.disconnect();
      this.visibilityObserver = undefined;
      void this.store.enableWorkbench();
    });
    this.visibilityObserver.observe(this.$el as Element);
  },
  beforeUnmount(): void {
    this.visibilityObserver?.disconnect();
  },
  methods: {
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
      void this.store.enableWorkbench({ analyze: true, refresh: true });
    },
    openInstructions(href: string): void {
      DocumentationDisclosure.openTarget(href);
    },
  },
});
