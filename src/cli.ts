#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import open from "open";
import { OutputFormatter } from "./artifacts/output-formatter.js";
import { InteractiveController } from "./automation/interactive-controller.js";
import { ConfigLoader } from "./config/config-loader.js";
import { TargetRegistry } from "./config/target-registry.js";
import { TARGET_NAMES, type TargetName } from "./config/types.js";
import { TestbenchPaths } from "./infrastructure/paths.js";
import { TestRunner } from "./orchestration/test-runner.js";
import { DoctorService } from "./setup/doctor-service.js";
import { McpIntegrationService, type McpClientId } from "./setup/mcp-integration-service.js";
import { SetupService } from "./setup/setup-service.js";
import { VerificationStore } from "./setup/verification-store.js";
import { FixtureServer } from "./support/fixture-server.js";
import { ApiServer } from "./transports/api-server.js";
import { McpServerHost } from "./transports/mcp-server.js";
import { RemoteTestbench } from "./transports/testbench-client.js";

const program = new Command();
program.name("browser-testbench").description("Portable browser and simulator test bench").version("0.1.0");

program
  .command("targets")
  .description("Ask the running Testbench which targets are available")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const capabilities = await new RemoteTestbench({ server: options.server, token: options.token }).capabilities();
    console.log(options.json ? JSON.stringify(capabilities, null, 2) : OutputFormatter.doctor(capabilities.checks));
  });

program
  .command("doctor")
  .description("Inspect prerequisites without triggering permission dialogs")
  .option("-t, --targets <names>", "Comma-separated targets")
  .option("--json", "Output JSON")
  .action(async (options) => {
    const targets = parseTargets(options.targets);
    const checks = await DoctorService.inspect(targets);
    console.log(options.json ? JSON.stringify(checks, null, 2) : OutputFormatter.doctor(checks));
    if (DoctorService.hasBlockingChecks(checks)) process.exitCode = 2;
  });

program
  .command("setup")
  .description("Prepare local Appium drivers and print guided system steps")
  .option("-t, --targets <names>", "Comma-separated targets")
  .option("--android-avd <name>", "Create a Google Play Android 36 AVD when command-line tools are available")
  .option("--yes", "Perform automatic downloads and installations")
  .option("--json", "Output JSON")
  .action(async (options) => {
    const targets = parseTargets(options.targets) ?? defaultTargets();
    const actions = options.yes
      ? await SetupService.install(targets, {
          androidAvdName: options.androidAvd,
          onOutput: (line) => !options.json && console.error(line),
        })
      : await SetupService.plan(targets);
    console.log(
      options.json
        ? JSON.stringify(actions, null, 2)
        : actions
            .map(
              (action) =>
                `${action.status.toUpperCase().padEnd(9)} ${action.label}${action.command ? ` — ${action.command}` : ""}${action.detail ? `\n          ${action.detail}` : ""}`,
            )
            .join("\n"),
    );
    if (actions.some((action) => action.status === "failed")) process.exitCode = 1;
  });

program
  .command("verify")
  .description("Run the built-in fixture test against one target")
  .argument("<target>", `One of: ${TARGET_NAMES.join(", ")}`)
  .option("--headless", "Use headless mode where supported")
  .action(async (name, options) => {
    const target = requireTarget(name);
    const fixture = new FixtureServer();
    const url = await fixture.start();
    try {
      const config = ConfigLoader.fromOptions({
        name: `verify-${target}`,
        url,
        targets: [target],
        headless: options.headless,
        specs: [resolve(TestbenchPaths.projectRoot, "examples", "smoke.spec.mjs")],
      });
      const summary = await new TestRunner().run(config);
      if (summary.status === "passed") await VerificationStore.record(target, summary.targets[0]?.runtime);
      console.log(OutputFormatter.summary(summary));
      if (summary.status !== "passed") process.exitCode = 1;
    } finally {
      await fixture.stop();
    }
  });

program
  .command("open")
  .description("Open an interactive browser/device session until Ctrl+C")
  .requiredOption("-t, --target <name>", "Target name")
  .requiredOption("-u, --url <url>", "URL")
  .option("--device-name <name>")
  .option("--platform-version <version>")
  .option("--avd <name>")
  .option("--udid <id>")
  .option("--headless")
  .action(async (options) => {
    const controller = new InteractiveController();
    const result = await controller.start({
      target: requireTarget(options.target),
      url: options.url,
      headless: options.headless,
      deviceName: options.deviceName,
      platformVersion: options.platformVersion,
      avd: options.avd,
      udid: options.udid,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("Session is open. Press Ctrl+C to close it.");
    await untilSignal();
    await controller.close();
  });

program
  .command("screenshot")
  .description("Capture a URL in a target browser")
  .requiredOption("-t, --target <name>", "Target name")
  .requiredOption("-u, --url <url>", "URL")
  .option("-o, --output <path>", "PNG output path")
  .option("--headless")
  .action(async (options) => {
    const controller = new InteractiveController();
    try {
      await controller.start({ target: requireTarget(options.target), url: options.url, headless: options.headless });
      const screenshot = await controller.screenshot(options.output ? resolve(options.output) : undefined);
      console.log(screenshot.path);
    } finally {
      await controller.close();
    }
  });

program
  .command("serve")
  .description("Start the browser Testbench service and setup UI")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--port <port>", "Bind port", "55808")
  .option("--token <token>", "Bearer token (recommended outside loopback)")
  .option("--no-open", "Do not open the setup UI in the default browser")
  .action(async (options) => {
    if (options.host !== "127.0.0.1" && options.host !== "localhost" && !options.token)
      throw new Error("A bearer token is required when binding outside loopback.");
    const server = new ApiServer({
      host: options.host,
      port: Number(options.port),
      token: options.token,
    });
    const address = await server.start();
    const url = `http://${address.host}:${address.port}/setup`;
    console.log(`Browser Testbench listening on ${url}`);
    if (options.open) {
      try {
        await open(url);
      } catch (error) {
        console.error(`Could not open the setup UI automatically: ${error instanceof Error ? error.message : error}`);
      }
    }
    await untilSignal();
    await server.stop();
  });

program
  .command("mcp")
  .description("Start the MCP server over stdio")
  .action(async () => McpServerHost.start());

program
  .command("mcp-config")
  .description("Print the setup command or configuration for an MCP client")
  .option("--client <client>", "codex, claude-code, gemini-cli, copilot-vscode, or other", "codex")
  .action(async (options) => {
    const clients: McpClientId[] = ["codex", "claude-code", "gemini-cli", "copilot-vscode", "other"];
    if (!clients.includes(options.client)) throw new Error(`Unknown MCP client '${options.client}'.`);
    console.log((await McpIntegrationService.status(options.client)).command);
  });

function split(value?: string): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTargets(value?: string): TargetName[] | undefined {
  return split(value)?.map(requireTarget);
}

function requireTarget(value: string): TargetName {
  if (!TARGET_NAMES.includes(value as TargetName))
    throw new Error(`Unknown target '${value}'. Expected: ${TARGET_NAMES.join(", ")}`);
  return value as TargetName;
}

function defaultTargets(): TargetName[] {
  return TargetRegistry.defaultTargets();
}

function defaultServerUrl(): string {
  return process.env.BROWSER_TESTBENCH_URL ?? "http://127.0.0.1:55808";
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
