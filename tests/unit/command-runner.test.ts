import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("CommandRunner", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it.runIf(process.platform === "win32")("runs Windows command scripts through the command shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-command-runner-"));
    temporaryDirectories.push(directory);
    const script = join(directory, "echo-argument.cmd");
    await writeFile(script, "@echo off\r\necho %~1", "utf8");

    const result = await CommandRunner.run(script, ["hello world"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("returns a failed result when spawning throws synchronously", async () => {
    const result = await CommandRunner.run("invalid\0command");

    expect(result.code).toBe(-1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("null bytes");
  });

  it("finishes after the timeout when a process ignores graceful termination", async () => {
    const startedAt = Date.now();
    const result = await CommandRunner.run(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)'],
      { timeoutMs: 20 },
    );

    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("timed out after 20 ms");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("bounds buffered command output", async () => {
    const result = await CommandRunner.run(process.execPath, ["-e", 'process.stdout.write("x".repeat(2_000_000))']);

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(1024 * 1024);
  });
});
