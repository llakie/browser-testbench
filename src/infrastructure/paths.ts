import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PackageMetadata } from "../config/package-metadata.js";

export class TestbenchPaths {
  static readonly projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  static resolveFrom(base: string, value: string): string {
    return isAbsolute(value) ? value : resolve(base, value);
  }

  static cache(...segments: string[]): string {
    return join(this.projectRoot, ".cache", ...segments);
  }

  static localBinary(name: string): string {
    const executable = process.platform === "win32" ? `${name}.cmd` : name;
    return join(this.projectRoot, "node_modules", ".bin", executable);
  }

  static cliCommand(...args: string[]): string {
    return this.shellCommand([PackageMetadata.NAME, ...args]);
  }

  static shellCommand(parts: string[]): string {
    return parts.map((part) => this.shellArgument(part)).join(" ");
  }

  private static shellArgument(value: string): string {
    return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  }
}
