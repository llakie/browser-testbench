import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { InputSchemas } from "./input-schemas.js";
import { TargetRegistry } from "./target-registry.js";
import { TARGET_NAMES, type NormalizedConfig, type TargetConfig, type TestbenchConfig } from "./types.js";

const configSchema = z.strictObject({
  name: z.string().min(1),
  baseUrl: z.url(),
  webServer: z
    .strictObject({
      command: z.string().min(1),
      cwd: z.string().optional(),
      healthUrl: z.url().optional(),
      timeoutMs: z.number().int().positive().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  targets: z.array(InputSchemas.targetConfig).min(1),
  specs: z.array(z.string()).optional(),
  artifactsDir: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxDesktopWorkers: z.number().int().positive().optional(),
  failFast: z.boolean().optional(),
});

export class ConfigLoader {
  static validate(value: unknown): TestbenchConfig {
    return configSchema.parse(value) as TestbenchConfig;
  }

  static async find(startDirectory = process.cwd()): Promise<string | undefined> {
    const names = ["testbench.config.mjs", "testbench.config.js", "testbench.config.json"];
    for (const name of names) {
      const candidate = resolve(startDirectory, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next conventional name.
      }
    }
    return undefined;
  }

  static async load(filePath: string): Promise<NormalizedConfig> {
    const absolutePath = resolve(filePath);
    const configDir = dirname(absolutePath);
    let raw: unknown;

    if (extname(absolutePath) === ".json") {
      raw = JSON.parse(await readFile(absolutePath, "utf8"));
    } else {
      const loaded = await import(`${pathToFileURL(absolutePath).href}?updated=${Date.now()}`);
      raw = loaded.default ?? loaded.config;
    }

    return this.normalize(this.validate(raw), configDir);
  }

  static fromOptions(options: {
    name?: string;
    url: string;
    targets: string[];
    specs?: string[];
    artifactsDir?: string;
    headless?: boolean;
  }): NormalizedConfig {
    const parsedTargets: TargetConfig[] = options.targets.map((name) => {
      if (!TargetRegistry.isTargetName(name)) {
        throw new Error(`Unknown target '${name}'. Expected one of: ${TARGET_NAMES.join(", ")}`);
      }
      return { name, headless: options.headless };
    });
    return this.normalize(
      {
        name: options.name ?? "ad-hoc",
        baseUrl: options.url,
        targets: parsedTargets,
        specs: options.specs,
        artifactsDir: options.artifactsDir,
      },
      process.cwd(),
    );
  }

  static normalize(config: TestbenchConfig, configDir: string): NormalizedConfig {
    return {
      ...config,
      configDir,
      targets: config.targets
        .map((target) => TargetRegistry.normalize(target))
        .filter((target) => target.enabled !== false),
      artifactsDir: TestbenchPaths.resolveFrom(configDir, config.artifactsDir ?? "artifacts"),
      timeoutMs: config.timeoutMs ?? 30_000,
      maxDesktopWorkers: config.maxDesktopWorkers ?? 2,
      failFast: config.failFast ?? false,
      webServer: config.webServer
        ? {
            ...config.webServer,
            cwd: TestbenchPaths.resolveFrom(configDir, config.webServer.cwd ?? "."),
          }
        : undefined,
    };
  }
}
