import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "vite";

const require = createRequire(import.meta.url);
const watcher = await build({ build: { watch: {} } });

if (!("on" in watcher)) throw new Error("Vite did not start in watch mode.");

await new Promise((resolve, reject) => {
  const ready = (event) => {
    if (event.code === "BUNDLE_END") {
      watcher.off("event", ready);
      resolve();
    } else if (event.code === "ERROR") {
      watcher.off("event", ready);
      reject(event.error);
    }
  };
  watcher.on("event", ready);
});

const cli = spawn(process.execPath, [require.resolve("tsx/cli"), "src/cli.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
});

let stopping = false;
const stop = async (signal) => {
  if (stopping) return;
  stopping = true;
  cli.kill(signal);
  await watcher.close();
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
cli.once("exit", async (code, signal) => {
  await watcher.close();
  if (!stopping) process.exitCode = signal ? 1 : (code ?? 1);
});
