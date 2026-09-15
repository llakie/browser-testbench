import { randomUUID } from "node:crypto";
import { hostname, platform, release } from "node:os";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactManager } from "../artifacts/artifact-manager.js";
import { eventBus, type TestbenchEventBus } from "./event-bus.js";
import { ServiceManager, type ManagedProcess } from "../infrastructure/process-manager.js";
import { BrowserSession } from "../automation/browser-session.js";
import { SpecLoader } from "./spec-loader.js";
import { TargetRegistry } from "../config/target-registry.js";
import { VideoRecorder } from "../automation/video-recorder.js";
import { MobileGestures } from "../automation/mobile-gestures.js";
import { TargetSelector } from "./target-selector.js";
import type {
  NormalizedConfig,
  RunSummary,
  TargetConfig,
  TargetRunResult,
  TestCase,
  TestResult,
} from "../config/types.js";

export class TestRunner {
  constructor(private readonly events: TestbenchEventBus = eventBus) {}

  static createRunId(): string {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  }

  async run(config: NormalizedConfig, runId = TestRunner.createRunId()): Promise<RunSummary> {
    const artifacts = new ArtifactManager(config.artifactsDir, runId);
    await artifacts.initialize();
    const summary: RunSummary = {
      id: runId,
      name: config.name,
      status: "running",
      startedAt: new Date().toISOString(),
      baseUrl: config.baseUrl,
      artifactDir: artifacts.runDir,
      targets: [],
    };
    await this.writeManifest(artifacts, config, summary);
    this.events.publish({ type: "run.started", runId, data: { name: config.name, baseUrl: config.baseUrl } });

    let appium: { process: ManagedProcess; port: number } | undefined;
    try {
      const selection = await TargetSelector.resolve(config.targets);
      summary.targets.push(...selection.unavailable);
      const tests = await SpecLoader.load(config);
      if (
        selection.runnable.some(
          (target) =>
            TargetRegistry.definitions[target.name].kind === "mobile" && TargetRegistry.isSupported(target.name),
        )
      ) {
        appium = await ServiceManager.startAppium();
      }

      const parallel = selection.runnable.filter((target) => !TargetRegistry.definitions[target.name].serial);
      const serial = selection.runnable.filter((target) => TargetRegistry.definitions[target.name].serial);
      summary.targets.push(
        ...(await this.runPool(parallel, config.maxDesktopWorkers, (target) =>
          this.runTarget(target, tests, config, artifacts, runId, appium?.port),
        )),
      );
      for (const target of serial) {
        const result = await this.runTarget(target, tests, config, artifacts, runId, appium?.port);
        summary.targets.push(result);
        if (config.failFast && result.status === "failed") break;
      }
      const executed = summary.targets.filter((target) => !selection.unavailable.includes(target));
      const executionFailed = executed.some((target) => target.status !== "passed");
      const unavailableIsFailure = config.targetPolicy === "strict" && selection.unavailable.length > 0;
      summary.status = executionFailed || unavailableIsFailure || selection.runnable.length === 0 ? "failed" : "passed";
    } catch (error) {
      summary.status = "failed";
      this.events.publish({ type: "run.error", runId, data: { error: this.errorMessage(error) } });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { summary });
    } finally {
      if (appium?.process.recentOutput) await artifacts.writeRunFile("appium.log", appium.process.recentOutput);
      await appium?.process.stop();
      summary.finishedAt = new Date().toISOString();
      await artifacts.writeSummary(summary);
      this.events.publish({
        type: "run.finished",
        runId,
        data: { status: summary.status, artifactDir: summary.artifactDir },
      });
    }
    return summary;
  }

  private async runTarget(
    target: TargetConfig,
    tests: TestCase[],
    config: NormalizedConfig,
    artifacts: ArtifactManager,
    runId: string,
    appiumPort?: number,
  ): Promise<TargetRunResult> {
    const started = Date.now();
    if (!TargetRegistry.isSupported(target.name)) {
      return {
        target: target.name,
        status: "unavailable",
        durationMs: 0,
        tests: [],
        error: `Unsupported on ${process.platform}.`,
      };
    }
    this.events.publish({ type: "target.started", runId, target: target.name });
    const session = new BrowserSession();
    const results: TestResult[] = [];
    const targetArtifacts: string[] = [];
    let recorder: VideoRecorder | undefined;
    let finalResult: TargetRunResult | undefined;
    try {
      const browser = await session.start(target, { appiumPort });
      const runtime = this.runtimeDetails(browser.capabilities as Record<string, unknown>);
      if (target.recordVideo)
        recorder = await VideoRecorder.start(target, artifacts.targetDir(target.name), browser.capabilities);
      for (const test of tests) {
        if (test.skipTargets?.includes(target.name) || (test.onlyTargets && !test.onlyTargets.includes(target.name))) {
          results.push({ name: test.name, target: target.name, status: "skipped", durationMs: 0, artifacts: [] });
          continue;
        }
        const testStarted = Date.now();
        const testArtifacts: string[] = [];
        this.events.publish({ type: "test.started", runId, target: target.name, test: test.name });
        try {
          await session.navigate(BrowserSession.urlForTarget(config.baseUrl, target));
          await test.run({
            browser,
            baseUrl: config.baseUrl,
            target,
            step: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
              this.events.publish({ type: "test.step", runId, target: target.name, test: test.name, data: { name } });
              return action();
            },
            screenshot: async (name = test.name) => {
              const path = await artifacts.screenshot(browser, target.name, name);
              testArtifacts.push(path);
              this.events.publish({
                type: "artifact.created",
                runId,
                target: target.name,
                test: test.name,
                data: { path, kind: "screenshot" },
              });
              return path;
            },
            gesture: async (input) => MobileGestures.perform(browser, target, input),
          });
          results.push({
            name: test.name,
            target: target.name,
            status: "passed",
            durationMs: Date.now() - testStarted,
            artifacts: testArtifacts,
          });
          this.events.publish({
            type: "test.finished",
            runId,
            target: target.name,
            test: test.name,
            data: { status: "passed" },
          });
        } catch (error) {
          try {
            testArtifacts.push(await artifacts.screenshot(browser, target.name, `${test.name}-failure`));
            testArtifacts.push(await artifacts.pageSource(browser, target.name, `${test.name}-failure-source`));
            const logs = await browser.browserLogs();
            testArtifacts.push(await artifacts.writeTargetJson(target.name, `${test.name}-browser-logs`, logs));
          } catch {
            // Preserve the original test failure if artifact collection also fails.
          }
          const message = this.errorMessage(error);
          results.push({
            name: test.name,
            target: target.name,
            status: "failed",
            durationMs: Date.now() - testStarted,
            error: message,
            artifacts: testArtifacts,
          });
          this.events.publish({
            type: "test.finished",
            runId,
            target: target.name,
            test: test.name,
            data: { status: "failed", error: message },
          });
          if (config.failFast) break;
        }
      }
      const status = results.some((test) => test.status === "failed") ? "failed" : "passed";
      finalResult = {
        target: target.name,
        status,
        durationMs: Date.now() - started,
        tests: results,
        runtime,
        artifacts: targetArtifacts,
      };
      return finalResult;
    } catch (error) {
      finalResult = {
        target: target.name,
        status: "unavailable",
        durationMs: Date.now() - started,
        tests: results,
        error: this.errorMessage(error),
        artifacts: targetArtifacts,
      };
      return finalResult;
    } finally {
      if (recorder) {
        try {
          const path = await recorder.stop();
          targetArtifacts.push(path);
          this.events.publish({ type: "artifact.created", runId, target: target.name, data: { path, kind: "video" } });
        } catch (error) {
          const message = this.errorMessage(error);
          targetArtifacts.push(await artifacts.writeTargetJson(target.name, "video-error", { error: message }));
          if (finalResult) {
            finalResult.status = "failed";
            finalResult.error = `Video recording failed: ${message}`;
          }
        }
      }
      await session.close().catch(() => undefined);
      this.events.publish({
        type: "target.finished",
        runId,
        target: target.name,
        data: { durationMs: Date.now() - started },
      });
    }
  }

  private async runPool<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) results[index] = await task(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  private async writeManifest(
    artifacts: ArtifactManager,
    config: NormalizedConfig,
    summary: RunSummary,
  ): Promise<void> {
    await writeFile(
      join(artifacts.runDir, "manifest.json"),
      `${JSON.stringify(
        {
          runId: summary.id,
          createdAt: summary.startedAt,
          testbenchVersion: "0.1.0",
          node: process.version,
          host: hostname(),
          platform: platform(),
          release: release(),
          targets: config.targets,
          baseUrl: config.baseUrl,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
  }

  private runtimeDetails(capabilities: Record<string, unknown>): Record<string, unknown> {
    const keys = ["browserName", "browserVersion", "platformName", "platformVersion", "deviceName"];
    return Object.fromEntries(
      keys.flatMap((key) => (capabilities[key] === undefined ? [] : [[key, capabilities[key]]])),
    );
  }
}
