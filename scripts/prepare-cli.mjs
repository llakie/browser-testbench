import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

await chmod(resolve("dist", "cli.js"), 0o755);
