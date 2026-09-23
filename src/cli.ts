#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import open from "open";
import { OutputFormatter } from "./cli/output-formatter.js";
import { Translator } from "./i18n/translator.js";
import { TestbenchDefaults } from "./config/defaults.js";
import { PackageMetadata } from "./config/package-metadata.js";
import { TargetRegistry } from "./config/target-registry.js";
import { TARGET_NAMES, type TargetName } from "./config/types.js";
import { DoctorService } from "./setup/doctor-service.js";
import { McpIntegrationService, type McpClientId } from "./setup/mcp-integration-service.js";
import { ApiServer } from "./transports/api-server.js";
import { McpServerHost } from "./transports/mcp-server.js";
import { RemoteTestbench } from "./transports/testbench-client.js";
import type { RemoteInstance, RemoteRole } from "./remote/remote-types.js";

const program = new Command();
program
  .name(PackageMetadata.NAME)
  .description("Portable browser and simulator test bench")
  .version(PackageMetadata.VERSION);

program
  .command("discover")
  .description("Find remotely enabled Testbenches on the local network")
  .option("--server <url>", "Local Testbench URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const instances = await new RemoteTestbench({ server: options.server, token: options.token }).discoverTestbenches();
    console.log(
      options.json
        ? JSON.stringify(instances, null, 2)
        : instances.length
          ? instances.map(formatRemoteInstance).join("\n")
          : "No remote Testbench was found. Check --remote, multicast UDP 5353, VPN settings, and the remote host's firewall, or use connect --server <url>.",
    );
  });

program
  .command("connect")
  .description("Connect the local Testbench gateway to a remote Testbench")
  .argument("[name-or-id]", "Discovered instance name or ID")
  .option("--server <url>", "Remote Testbench URL when discovery is unavailable")
  .option("--gateway <url>", "Local Testbench gateway URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--admin", "Request administrative access")
  .option("--code <code>", "Six-digit pairing code")
  .option("--json", "Output JSON")
  .action(async (selector, options) => {
    const testbench = new RemoteTestbench({ server: options.gateway, token: options.token });
    const instance = options.server
      ? await testbench.remoteIdentity(options.server)
      : selectRemote(await testbench.discoverTestbenches(), selector);
    const role: RemoteRole = options.admin ? "admin" : "control";
    const result = await testbench.connectTestbench(instance, role);
    if (!("pairingRequired" in result)) {
      console.log(options.json ? JSON.stringify(result, null, 2) : `Connected to ${result.remote?.instanceName}.`);
      return;
    }
    const code = options.code ?? (await promptPairingCode(instance.name));
    const connected = await testbench.completePairing(result.pairingId, code);
    console.log(options.json ? JSON.stringify(connected, null, 2) : `Paired and connected to ${instance.name}.`);
  });

program
  .command("status")
  .description("Show whether the local Testbench uses local or remote targets")
  .option("--server <url>", "Local Testbench URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const status = await new RemoteTestbench({ server: options.server, token: options.token }).connection();
    console.log(
      options.json
        ? JSON.stringify(status, null, 2)
        : status.mode === "local"
          ? "Local mode"
          : `Remote mode — ${status.remote?.instanceName} (${status.remote?.role}) — ${status.reachable ? "reachable" : "unreachable"}`,
    );
  });

program
  .command("disconnect")
  .description("Disconnect the active remote Testbench and return to local mode")
  .option("--server <url>", "Local Testbench URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const status = await new RemoteTestbench({ server: options.server, token: options.token }).disconnectTestbench();
    console.log(options.json ? JSON.stringify(status, null, 2) : "Disconnected. The Testbench is using local targets.");
  });

program
  .command("targets")
  .description("Ask the running Testbench which targets are available")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const targets = await new RemoteTestbench({ server: options.server, token: options.token }).targets();
    console.log(
      options.json
        ? JSON.stringify(targets, null, 2)
        : targets
            .map(
              (target) =>
                `${(target.ready ? "READY" : target.status.toUpperCase()).padEnd(8)} ${target.id} — ${target.label}`,
            )
            .join("\n"),
    );
  });

program
  .command("doctor")
  .description("Inspect prerequisites without triggering permission dialogs")
  .option("-t, --targets <names>", "Comma-separated targets")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const targets = parseTargets(options.targets);
    const checks = await new RemoteTestbench({ server: options.server, token: options.token }).doctor(targets);
    console.log(options.json ? JSON.stringify(checks, null, 2) : OutputFormatter.doctor(checks));
    if (DoctorService.hasBlockingChecks(checks)) process.exitCode = 2;
  });

program
  .command("setup")
  .description("Prepare local Appium drivers and print guided system steps")
  .option("-t, --targets <names>", "Comma-separated targets")
  .option("--yes", "Perform automatic downloads and installations")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (options) => {
    const targets = parseTargets(options.targets) ?? defaultTargets();
    const testbench = new RemoteTestbench({ server: options.server, token: options.token });
    const actions = options.yes ? await testbench.setup(targets) : await testbench.planSetup(targets);
    console.log(options.json ? JSON.stringify(actions, null, 2) : OutputFormatter.setup(actions));
    if (actions.some((action) => action.status === "failed")) process.exitCode = 1;
  });

program
  .command("verify")
  .description("Run a remote-control smoke test against one concrete target ID")
  .argument("<target>", "Test target ID returned by the targets command")
  .option("--headless", "Use headless mode where supported")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .option("--json", "Output JSON")
  .action(async (targetId, options) => {
    const testbench = new RemoteTestbench({ server: options.server, token: options.token });
    const target = (await testbench.targets()).find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`Unknown target '${targetId}'. Run 'browser-testbench targets' to list valid IDs.`);
    if (target.status === "blocked" || target.status === "skip")
      throw new Error(`Target '${targetId}' is not ready: ${new Translator("en").text(target.detail)}`);
    const result = await testbench.verify(target.id, { headless: options.headless });
    console.log(options.json ? JSON.stringify(result, null, 2) : `PASS ${target.id} (${result.durationMs} ms)`);
  });

program
  .command("open")
  .description("Open an interactive browser/device session until Ctrl+C")
  .requiredOption("-t, --target <id>", "Test target ID")
  .requiredOption("-u, --url <url>", "URL")
  .option("--download-dir <path>")
  .option("--video <path>", "Record a mobile simulator session to MP4")
  .option("--headless")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .action(async (options) => {
    const session = await new RemoteTestbench({ server: options.server, token: options.token }).open({
      target: options.target,
      url: options.url,
      headless: options.headless,
      downloadDir: options.downloadDir ? resolve(options.downloadDir) : undefined,
      videoPath: options.video ? resolve(options.video) : undefined,
    });
    try {
      console.log(JSON.stringify({ id: session.id, target: session.target, runtime: session.runtime }, null, 2));
      console.log("Session is open. Press Ctrl+C to close it.");
      await untilSignal();
    } finally {
      await session.close();
    }
  });

program
  .command("screenshot")
  .description("Capture a URL in a target browser")
  .requiredOption("-t, --target <id>", "Test target ID")
  .requiredOption("-u, --url <url>", "URL")
  .option("-o, --output <path>", "PNG output path")
  .option("--headless")
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .action(async (options) => {
    const session = await new RemoteTestbench({ server: options.server, token: options.token }).open({
      target: options.target,
      url: options.url,
      headless: options.headless,
    });
    try {
      const output = resolve(options.output ?? `screenshot-${Date.now()}.png`);
      console.log(await session.screenshot(output));
    } finally {
      await session.close();
    }
  });

program
  .command("start")
  .description("Start the browser Testbench service and setup UI")
  .option("--host <host>", "Bind host")
  .option("--port <port>", "Bind port", String(TestbenchDefaults.PORT))
  .option("--token <token>", "Bearer token (recommended outside loopback)")
  .option("--remote", "Allow paired clients and advertise this Testbench on the local network")
  .option("--live-reload", "Reload the UI when templates or assets change", import.meta.url.endsWith(".ts"))
  .option("--no-open", "Do not open the setup UI in the default browser")
  .action(async (options) => {
    const host = options.host ?? (options.remote ? "0.0.0.0" : TestbenchDefaults.LOOPBACK_HOST);
    if (!options.remote && host !== TestbenchDefaults.LOOPBACK_HOST && host !== "localhost" && !options.token)
      throw new Error("A bearer token is required when binding outside loopback.");
    const server = new ApiServer({
      host,
      port: Number(options.port),
      token: options.token,
      liveReload: options.liveReload,
      remote: options.remote,
    });
    const address = await server.start();
    const browserHost =
      address.host === "0.0.0.0" || address.host === "::" ? TestbenchDefaults.LOOPBACK_HOST : address.host;
    const url = `http://${browserHost}:${address.port}/setup`;
    console.log(`Browser Testbench listening on ${url}${options.remote ? " (remote access enabled)" : ""}`);
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
  .option("--server <url>", "Testbench server URL", defaultServerUrl())
  .option("--token <token>", "Bearer token", process.env.BROWSER_TESTBENCH_TOKEN)
  .action(async (options) => McpServerHost.start({ server: options.server, token: options.token }));

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
  return process.env.BROWSER_TESTBENCH_URL ?? TestbenchDefaults.SERVER_URL;
}

function formatRemoteInstance(instance: RemoteInstance): string {
  return `${instance.name} — ${instance.platform}/${instance.architecture} — ${instance.authentication} — ${instance.url} — ${instance.instanceId}`;
}

function selectRemote(instances: RemoteInstance[], selector?: string): RemoteInstance {
  if (!selector) {
    if (instances.length === 1) return instances[0]!;
    if (instances.length === 0) throw new Error("No remote Testbench was found. Use --server <url> as a fallback.");
    throw new Error("Multiple remote Testbenches were found. Specify a name or instance ID.");
  }
  const normalized = selector.toLocaleLowerCase();
  const matches = instances.filter(
    (instance) => instance.instanceId === selector || instance.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length ? `Remote Testbench '${selector}' is ambiguous.` : `Remote Testbench '${selector}' was not found.`,
    );
  return matches[0]!;
}

async function promptPairingCode(instanceName: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Pairing is required. Re-run with --code <six-digit-code>.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(`Enter the pairing code shown on ${instanceName}: `)).trim();
  } finally {
    input.close();
  }
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
