import { defineComponent } from "vue";
import { translator } from "../core/translator.js";

export const CommandBlock = defineComponent({
  props: {
    value: { type: String, required: true },
    multiline: Boolean,
    copyLabel: { type: String, default: "command" },
  },
  data: () => ({ copied: false }),
  computed: {
    accessibleLabel(): string {
      return translator.t(this.copyLabel === "targetId" ? "common.actions.copyTargetId" : "common.actions.copyCommand");
    },
  },
  methods: {
    async copy(): Promise<void> {
      await navigator.clipboard.writeText(this.value);
      this.copied = true;
    },
  },
  template: `
    <div :class="['command-block', { 'command-block--multiline': multiline }]">
      <code>{{ value }}</code>
      <button class="copy-command" type="button" :title="accessibleLabel" :aria-label="accessibleLabel" @click="copy">
        <i :class="['fa-solid', copied ? 'fa-check' : 'fa-copy']" aria-hidden="true"></i>
      </button>
    </div>`,
});
