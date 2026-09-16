import { createRequire } from "node:module";

const packageJson = createRequire(import.meta.url)("../../package.json") as { name: string; version: string };

export class PackageMetadata {
  static readonly NAME = packageJson.name;
  static readonly VERSION = packageJson.version;
}
