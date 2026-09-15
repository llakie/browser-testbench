import { ConfigLoader } from "../config/config-loader.js";
import { join } from "node:path";
import { eventBus } from "./event-bus.js";
import { TestRunner } from "./test-runner.js";
import type { RunInput } from "../config/input-schemas.js";
import type { RunSummary } from "../config/types.js";

export class RunStore {
  private readonly runs = new Map<string, RunSummary>();
  private readonly pending = new Map<string, Promise<RunSummary>>();

  async start(input: RunInput): Promise<RunSummary> {
    const config = input.configPath
      ? await ConfigLoader.load(input.configPath)
      : ConfigLoader.fromOptions({
          url: input.url ?? "http://127.0.0.1:4173",
          targets: input.targets ?? ["chrome"],
          headless: input.headless,
          specs: input.specs,
        });
    const runner = new TestRunner(eventBus);
    const runId = TestRunner.createRunId();
    const placeholder: RunSummary = {
      id: runId,
      name: config.name,
      status: "running",
      startedAt: new Date().toISOString(),
      baseUrl: config.baseUrl,
      artifactDir: join(config.artifactsDir, runId),
      targets: [],
    };

    const promise = runner.run(config, runId);
    this.runs.set(runId, placeholder);
    this.pending.set(runId, promise);
    void promise
      .then((summary) => this.runs.set(summary.id, summary))
      .catch((error: Error & { summary?: RunSummary }) => {
        if (error.summary) this.runs.set(error.summary.id, error.summary);
      })
      .finally(() => this.pending.delete(runId));
    return placeholder;
  }

  get(id: string): RunSummary | undefined {
    return this.runs.get(id);
  }

  async wait(id: string): Promise<RunSummary> {
    const pending = this.pending.get(id);
    if (!pending) {
      const existing = this.runs.get(id);
      if (!existing) throw new Error(`Unknown run '${id}'.`);
      return existing;
    }
    try {
      return await pending;
    } finally {
      this.pending.delete(id);
    }
  }

  list(): RunSummary[] {
    return [...this.runs.values()];
  }
}

export const runStore = new RunStore();
