import { Translator, type SupportedLocale } from "../../../i18n/translator.js";
import type { TranslatableText } from "../../../i18n/translator.js";

const locale =
  typeof document !== "undefined" && document.querySelector<HTMLElement>("#app")?.dataset.locale === "de" ? "de" : "en";

export const translator = new Translator(locale satisfies SupportedLocale);

export function localized(
  value: Partial<Record<"label" | "detail" | "action", TranslatableText>>,
  field: "label" | "detail" | "action",
): string {
  return translator.text(value[field]);
}
