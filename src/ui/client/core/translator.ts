import { Translator, type SupportedLocale } from "../../../i18n/translator.js";
import type { LocalizedFields } from "../../../config/types.js";

const locale =
  typeof document !== "undefined" && document.querySelector<HTMLElement>("#app")?.dataset.locale === "de" ? "de" : "en";

export const translator = new Translator(locale satisfies SupportedLocale);

export function localized(
  value: { messages?: LocalizedFields } & Partial<Record<"label" | "detail" | "action", string>>,
  field: "label" | "detail" | "action",
): string {
  return translator.message(value.messages?.[field], value[field] ?? "");
}
