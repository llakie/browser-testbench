import { describe, expect, it } from "vitest";
import { LocaleResolver, Translator, type MessageKey } from "../../src/i18n/translator.js";

describe("LocaleResolver", () => {
  it("selects the supported browser language with the highest quality", () => {
    expect(LocaleResolver.resolve("fr-FR;q=0.9, de-AT;q=0.8, en;q=0.7")).toBe("de");
    expect(LocaleResolver.resolve("de;q=0.5, en-US;q=0.9")).toBe("en");
  });

  it("falls back to English", () => {
    expect(LocaleResolver.resolve("fr-FR")).toBe("en");
    expect(LocaleResolver.resolve(undefined)).toBe("en");
  });
});

describe("Translator", () => {
  it("interpolates named values and selects plural forms", () => {
    const translator = new Translator("de");
    expect(translator.t("checklist.intro", { deviceName: "iPhone X" })).toContain("iPhone X");
    expect(translator.t("checklist.completed", { count: 1 }, 1)).toBe("1 Schritt abgeschlossen");
    expect(translator.t("checklist.completed", { count: 2 }, 2)).toBe("2 Schritte abgeschlossen");
  });

  it("makes missing keys and parameters visible in every locale", () => {
    expect(new Translator("en").t("missing.key" as MessageKey)).toBe("en[missing.key]");
    expect(new Translator("de").t("checklist.intro")).toContain("de[checklist.intro.deviceName]");
  });

  it("keeps dictionary keys, plural categories, and placeholders aligned", () => {
    expect(Translator.keys("de")).toEqual(Translator.keys("en"));
    for (const key of Translator.keys("en")) {
      const english = Translator.value("en", key);
      const german = Translator.value("de", key);
      expect(structure(german), key).toEqual(structure(english));
    }
  });
});

function structure(value: ReturnType<typeof Translator.value>): Record<string, string[]> {
  if (typeof value === "string") return { text: placeholders(value) };
  return Object.fromEntries(Object.entries(value ?? {}).map(([category, text]) => [category, placeholders(text)]));
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]!).sort();
}
