import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PackageMetadata } from "../config/package-metadata.js";

interface NodePackageManifest {
  bin?: string | Record<string, string>;
}

export class NodePackageResolver {
  static directory(packageName: string, parentUrl = import.meta.url): string {
    const require = createRequire(parentUrl);
    return dirname(require.resolve(`${packageName}/package.json`));
  }

  static binary(packageName: string, binaryName = packageName, parentUrl = import.meta.url): string {
    const directory = this.directory(packageName, parentUrl);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as NodePackageManifest;
    const relativePath = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binaryName];
    if (!relativePath) throw new Error(`Package ${packageName} does not provide the ${binaryName} binary.`);
    return resolve(directory, relativePath);
  }
}

export class TestbenchDataDirectory {
  static resolve(
    platform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
    home = homedir(),
  ): string {
    if (environment.BROWSER_TESTBENCH_DATA_DIR) return resolve(environment.BROWSER_TESTBENCH_DATA_DIR);
    if (platform === "win32") {
      return join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), PackageMetadata.NAME);
    }
    if (platform === "darwin") return join(home, "Library", "Application Support", PackageMetadata.NAME);
    return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), PackageMetadata.NAME);
  }
}

export class TestbenchPaths {
  static readonly projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  static readonly dataRoot = TestbenchDataDirectory.resolve();

  static resolveFrom(base: string, value: string): string {
    return isAbsolute(value) ? value : resolve(base, value);
  }

  static data(...segments: string[]): string {
    return join(this.dataRoot, ...segments);
  }

  static packageDirectory(packageName: string): string {
    return NodePackageResolver.directory(packageName);
  }

  static packageBinary(packageName: string, binaryName = packageName): string {
    return NodePackageResolver.binary(packageName, binaryName);
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
