import { defineComponent } from "vue";

export const CommandBlock = defineComponent({
  props: {
    value: { type: String, required: true },
    multiline: Boolean,
    copyLabel: { type: String, default: "Command" },
  },
  data: () => ({ copied: false }),
  computed: {
    accessibleLabel(): string {
      return this.copyLabel === "Target ID" ? "Copy target ID" : "Copy command";
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
