export class NetworkUrl {
  static isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/u, "");
    return (
      normalized === "localhost" ||
      normalized === "::1" ||
      normalized === "[::1]" ||
      normalized === "0.0.0.0" ||
      normalized.startsWith("127.")
    );
  }

  static withHostname(value: string, hostname: string): string {
    const url = new URL(value);
    url.hostname = hostname;
    return url.toString();
  }

  static comparableHostname(hostname: string): string {
    return hostname
      .toLowerCase()
      .replace(/^www\./u, "")
      .replace(/\.$/u, "");
  }
}
