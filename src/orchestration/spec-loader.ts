import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fg from "fast-glob";
import type { NormalizedConfig, TestCase, TestModule } from "../config/types.js";

export class SpecLoader {
  static async load(config: NormalizedConfig): Promise<TestCase[]> {
    if (!config.specs?.length) return [this.smokeTest()];
    const paths = await fg(config.specs, { cwd: config.configDir, absolute: true, onlyFiles: true });
    if (paths.length === 0) throw new Error(`No specs matched: ${config.specs.join(", ")}`);

    const tests: TestCase[] = [];
    for (const path of paths.sort()) {
      const module = (await import(`${pathToFileURL(resolve(path)).href}?updated=${Date.now()}`)) as Record<
        string,
        unknown
      >;
      const exported = module.default ?? module.tests;
      const candidates = Array.isArray(exported) ? exported : (exported as TestModule | undefined)?.tests;
      if (!Array.isArray(candidates))
        throw new Error(`Spec ${path} must export an array of test cases or { tests: [...] }.`);
      for (const candidate of candidates) this.validate(candidate, path);
      tests.push(...(candidates as TestCase[]));
    }
    return tests;
  }

  private static validate(candidate: unknown, path: string): asserts candidate is TestCase {
    if (!candidate || typeof candidate !== "object") throw new Error(`Invalid test case in ${path}.`);
    const test = candidate as Partial<TestCase>;
    if (!test.name || typeof test.run !== "function")
      throw new Error(`Every test in ${path} needs a name and async run(context) function.`);
  }

  private static smokeTest(): TestCase {
    return {
      name: "page loads",
      async run({ browser }) {
        const title = await browser.getTitle();
        const source = await browser.getPageSource();
        if (!source || source.length < 20) throw new Error("The page source is empty.");
        if (!(await browser.getUrl()).startsWith("http")) throw new Error("The browser did not reach an HTTP(S) URL.");
        void title;
      },
    };
  }
}
