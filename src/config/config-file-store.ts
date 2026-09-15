import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { ConfigLoader } from "./config-loader.js";
import type { TargetName, TestbenchConfig } from "./types.js";

export interface StoredConfig {
  config: TestbenchConfig;
  exists: boolean;
  path: string;
}

export class ConfigFileStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    if (extname(this.path) !== ".json") throw new Error("The setup UI requires a .json configuration file.");
  }

  async read(): Promise<StoredConfig> {
    if (!(await this.exists())) return { config: this.defaultConfig(), exists: false, path: this.path };
    const value = JSON.parse(await readFile(this.path, "utf8"));
    return { config: ConfigLoader.validate(value), exists: true, path: this.path };
  }

  async save(value: unknown): Promise<StoredConfig> {
    const config = ConfigLoader.validate(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
    return { config, exists: true, path: this.path };
  }

  private defaultConfig(): TestbenchConfig {
    const projectDirectory = dirname(this.path);
    const targets: TargetName[] = process.platform === "win32" ? ["chrome", "firefox", "edge"] : ["chrome", "firefox"];
    return {
      name: basename(projectDirectory) || "browser-tests",
      baseUrl: "http://127.0.0.1:3000",
      webServer: {
        command: "npm run dev",
        cwd: ".",
      },
      targets,
      specs: ["tests/browser/**/*.spec.mjs"],
      artifactsDir: "artifacts/browser-testbench",
      maxDesktopWorkers: 2,
      failFast: false,
    };
  }

  private async exists(): Promise<boolean> {
    try {
      await access(this.path);
      return true;
    } catch {
      return false;
    }
  }

  displayPath(from = process.cwd()): string {
    const candidate = relative(from, this.path);
    return candidate && !candidate.startsWith("..") ? candidate : this.path;
  }
}
