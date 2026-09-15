import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

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
}
