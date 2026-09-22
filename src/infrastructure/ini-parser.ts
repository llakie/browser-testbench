export class IniParser {
  static parse(content: string): ReadonlyMap<string, string> {
    const values = new Map<string, string>();
    for (const rawLine of content.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(";") || line.startsWith("#") || /^\[.*\]$/u.test(line)) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      if (!key) continue;
      values.set(key, line.slice(separator + 1).trim());
    }
    return values;
  }
}
