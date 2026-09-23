import english from "./en.json" with { type: "json" };
import german from "./de.json" with { type: "json" };

export type SupportedLocale = "en" | "de";
export type MessageParameters = Record<string, string | number>;
export interface MessageDescriptor {
  key: MessageKey;
  parameters?: MessageParameters;
  count?: number;
  formats?: Partial<Record<string, "date" | "number">>;
}

export type TranslatableText = string | MessageDescriptor;

type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
type MessageTree = { [key: string]: string | PluralMessage | MessageTree };
type NestedMessageKeys<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : T[Key] extends { other: string }
      ? Key
      : T[Key] extends Record<string, unknown>
        ? `${Key}.${NestedMessageKeys<T[Key]>}`
        : never;
}[keyof T & string];

export type MessageKey = NestedMessageKeys<typeof english>;

const dictionaries: Record<SupportedLocale, MessageTree> = { en: english, de: german };
const pluralCategories = new Set<Intl.LDMLPluralRule>(["zero", "one", "two", "few", "many", "other"]);

export class LocaleResolver {
  static resolve(acceptLanguage: string | string[] | undefined): SupportedLocale {
    const source = Array.isArray(acceptLanguage) ? acceptLanguage.join(",") : (acceptLanguage ?? "");
    const preferences = source
      .split(",")
      .map((entry, index) => {
        const [language = "", ...parameters] = entry.trim().split(";");
        const quality = parameters
          .map((parameter) => parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/iu)?.[1])
          .find(Boolean);
        return { language: language.toLowerCase(), quality: quality ? Number(quality) : 1, index };
      })
      .filter((entry) => entry.language && entry.quality > 0)
      .sort((left, right) => right.quality - left.quality || left.index - right.index);
    for (const preference of preferences) {
      const base = preference.language.split("-")[0];
      if (base === "de" || base === "en") return base;
    }
    return "en";
  }
}

export class Translator {
  private static readonly normalized = new Map<SupportedLocale, Map<string, string | PluralMessage>>();
  private readonly messages: Map<string, string | PluralMessage>;
  private readonly pluralRules: Intl.PluralRules;
  private readonly numberFormat: Intl.NumberFormat;

  constructor(readonly locale: SupportedLocale) {
    this.messages = Translator.dictionary(locale);
    this.pluralRules = new Intl.PluralRules(locale);
    this.numberFormat = new Intl.NumberFormat(locale);
  }

  t(key: MessageKey, parameters: MessageParameters = {}, count?: number): string {
    const message = this.messages.get(key);
    if (!message) return `${this.locale}[${key}]`;
    const template =
      typeof message === "string"
        ? message
        : (message[this.pluralRules.select(count ?? Number(parameters.count))] ?? message.other);
    const values = count === undefined ? parameters : { ...parameters, count };
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) return `${this.locale}[${key}.${name}]`;
      return typeof value === "number" ? this.numberFormat.format(value) : value;
    });
  }

  message(descriptor: MessageDescriptor | undefined, fallback: string): string {
    if (!descriptor) return fallback;
    const parameters = { ...descriptor.parameters };
    for (const [name, format] of Object.entries(descriptor.formats ?? {})) {
      const value = parameters[name];
      if (format === "date" && value !== undefined) parameters[name] = this.formatDate(value);
      if (format === "number" && typeof value === "number") parameters[name] = this.formatNumber(value);
    }
    return this.t(descriptor.key, parameters, descriptor.count);
  }

  text(value: TranslatableText | undefined): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    return this.message(value, "");
  }

  formatDate(value: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string {
    return new Intl.DateTimeFormat(this.locale, options).format(new Date(value));
  }

  formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
    return new Intl.NumberFormat(this.locale, options).format(value);
  }

  static keys(locale: SupportedLocale): string[] {
    return [...this.dictionary(locale).keys()].sort();
  }

  static value(locale: SupportedLocale, key: string): string | PluralMessage | undefined {
    return this.dictionary(locale).get(key);
  }

  private static dictionary(locale: SupportedLocale): Map<string, string | PluralMessage> {
    const existing = this.normalized.get(locale);
    if (existing) return existing;
    const messages = new Map<string, string | PluralMessage>();
    this.flatten(dictionaries[locale], "", messages);
    this.normalized.set(locale, messages);
    return messages;
  }

  private static flatten(tree: MessageTree, prefix: string, target: Map<string, string | PluralMessage>): void {
    for (const [name, value] of Object.entries(tree)) {
      const key = prefix ? `${prefix}.${name}` : name;
      if (typeof value === "string" || this.isPluralMessage(value)) target.set(key, value);
      else this.flatten(value, key, target);
    }
  }

  private static isPluralMessage(value: PluralMessage | MessageTree): value is PluralMessage {
    const entries = Object.entries(value);
    return (
      entries.some(([key]) => key === "other") &&
      entries.every(([key, text]) => pluralCategories.has(key as Intl.LDMLPluralRule) && typeof text === "string")
    );
  }
}

const englishErrors = new Translator("en");

export class LocalizedError extends Error {
  constructor(
    readonly descriptor: MessageDescriptor,
    readonly status = 500,
    options?: ErrorOptions,
  ) {
    super(englishErrors.message(descriptor, descriptor.key), options);
    this.name = "LocalizedError";
  }
}
