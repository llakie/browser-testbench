import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { PackageMetadata } from "../config/package-metadata.js";
import {
  McpClientExecutableResolver,
  type ExecutableMcpClientId,
  type ResolvedMcpClientExecutable,
} from "./mcp-client-executable-resolver.js";
import { McpServerLauncher } from "./mcp-server-launcher.js";
import { LocalizedError, type MessageDescriptor, type TranslatableText } from "../i18n/translator.js";

const REGISTRATION_STATUS_TIMEOUT_MS = 8_000;
const REGISTRATION_UPDATE_TIMEOUT_MS = 15_000;
const MCP_LAUNCHER_PREPARATION_TIMEOUT_MS = 120_000;

export type McpClientId = "codex" | "claude-code" | "gemini-cli" | "copilot-vscode" | "other";
export type AutomaticMcpClientId = Extract<McpClientId, "codex" | "claude-code" | "gemini-cli">;

export interface McpIntegrationStatus {
  id: McpClientId;
  label: TranslatableText;
  installed: boolean;
  automatic: boolean;
  registered: boolean;
  current: boolean;
  command: string;
  format: "command" | "json";
  detail: TranslatableText;
  instruction: TranslatableText;
  executable?: string;
  executableSource?: ResolvedMcpClientExecutable["source"];
}

interface McpClientDefinition {
  id: McpClientId;
  label: string;
  binary?: string;
  environmentVariable?: string;
  versionArgs?: string[];
  statusArgs?: string[];
  addArgs?: string[];
  removeArgs?: string[];
  command?: string;
  format?: "command" | "json";
  instruction: MessageDescriptor;
}

export class McpIntegrationService {
  static async statuses(): Promise<McpIntegrationStatus[]> {
    return Promise.all(this.definitions().map((definition) => this.status(definition.id)));
  }

  static async status(id: McpClientId): Promise<McpIntegrationStatus> {
    await McpServerLauncher.prepare();
    const definition = this.definition(id);
    const command = this.setupValue(definition);
    if (!definition.binary) {
      return {
        id,
        label: id === "other" ? { key: "mcp.otherLabel" } : definition.label,
        installed: true,
        automatic: false,
        registered: false,
        current: false,
        command,
        format: definition.format ?? "command",
        detail: { key: "mcp.configurationReady" },
        instruction: definition.instruction,
      };
    }

    const executable = await McpClientExecutableResolver.resolve({
      id: id as ExecutableMcpClientId,
      binary: definition.binary,
      environmentVariable: definition.environmentVariable!,
      versionArgs: definition.versionArgs,
    });
    if (!executable) {
      const configuredPath = process.env[definition.environmentVariable!]?.trim();
      return {
        id,
        label: definition.label,
        installed: false,
        automatic: false,
        registered: false,
        current: false,
        command,
        format: "command",
        detail: configuredPath
          ? {
              key: "mcp.configuredPathInvalid",
              parameters: { clientName: definition.label, environmentVariable: definition.environmentVariable! },
            }
          : {
              key: "mcp.notFound",
              parameters: { clientName: definition.label, environmentVariable: definition.environmentVariable! },
            },
        instruction: definition.instruction,
      };
    }

    if (!definition.statusArgs) {
      return {
        id,
        label: definition.label,
        installed: true,
        automatic: false,
        registered: false,
        current: false,
        command,
        format: "command",
        detail: { key: "mcp.available", parameters: { clientName: definition.label } },
        instruction: definition.instruction,
        executable: executable.command,
        executableSource: executable.source,
      };
    }

    const registration = await CommandRunner.run(executable.command, definition.statusArgs, {
      timeoutMs: REGISTRATION_STATUS_TIMEOUT_MS,
    });
    const output = `${registration.stdout}\n${registration.stderr}`;
    const registered = output.includes(PackageMetadata.NAME);
    const current = registration.code === 0 && registered && this.usesManagedLauncher(registration.stdout, output);
    return {
      id,
      label: definition.label,
      installed: true,
      automatic: id === "codex" || id === "claude-code" || id === "gemini-cli",
      registered,
      current,
      command,
      format: "command",
      detail: { key: this.registrationStatusKey(current, registered) },
      instruction: definition.instruction,
      executable: executable.command,
      executableSource: executable.source,
    };
  }

  static async register(id: AutomaticMcpClientId): Promise<McpIntegrationStatus> {
    const definition = this.definition(id);
    const existing = await this.status(id);
    if (!existing.installed)
      throw new LocalizedError({ key: "mcp.clientUnavailable", parameters: { clientName: definition.label } });
    if (existing.current) return existing;
    const executable = existing.executable!;
    const launcher = McpServerLauncher.command();
    const prepared = await CommandRunner.run(launcher.command, launcher.verificationArgs, {
      timeoutMs: MCP_LAUNCHER_PREPARATION_TIMEOUT_MS,
    });
    if (prepared.code !== 0) {
      const diagnostic = prepared.stderr.trim();
      if (diagnostic) throw new Error(diagnostic);
      throw new LocalizedError({ key: "mcp.launcherPreparationFailed" });
    }
    if (existing.registered) {
      const removed = await CommandRunner.run(executable, definition.removeArgs!, {
        timeoutMs: REGISTRATION_STATUS_TIMEOUT_MS,
      });
      if (removed.code !== 0) {
        const diagnostic = removed.stderr.trim();
        if (diagnostic) throw new Error(diagnostic);
        throw new LocalizedError({ key: "mcp.connectionRemovalFailed", parameters: { clientName: definition.label } });
      }
    }
    const added = await CommandRunner.run(executable, definition.addArgs!, {
      timeoutMs: REGISTRATION_UPDATE_TIMEOUT_MS,
    });
    if (added.code !== 0) {
      const diagnostic = added.stderr.trim();
      if (diagnostic) throw new Error(diagnostic);
      throw new LocalizedError({ key: "mcp.connectionSetupFailed", parameters: { clientName: definition.label } });
    }
    return this.status(id);
  }

  private static definitions(): McpClientDefinition[] {
    const launcher = McpServerLauncher.command();
    const stdioCommand = [launcher.command, ...launcher.args];
    const vscodeConfig = JSON.stringify({
      name: PackageMetadata.NAME,
      command: launcher.command,
      args: launcher.args,
    });
    return [
      {
        id: "codex",
        label: "Codex",
        binary: "codex",
        environmentVariable: "BROWSER_TESTBENCH_CODEX_PATH",
        statusArgs: ["mcp", "get", PackageMetadata.NAME, "--json"],
        addArgs: ["mcp", "add", PackageMetadata.NAME, "--", ...stdioCommand],
        removeArgs: ["mcp", "remove", PackageMetadata.NAME],
        instruction: { key: "mcp.codexInstruction" },
      },
      {
        id: "claude-code",
        label: "Claude Code",
        binary: "claude",
        environmentVariable: "BROWSER_TESTBENCH_CLAUDE_PATH",
        statusArgs: ["mcp", "get", PackageMetadata.NAME],
        addArgs: ["mcp", "add", "--transport", "stdio", "--scope", "user", PackageMetadata.NAME, "--", ...stdioCommand],
        removeArgs: ["mcp", "remove", PackageMetadata.NAME, "--scope", "user"],
        instruction: { key: "mcp.claudeInstruction" },
      },
      {
        id: "gemini-cli",
        label: "Gemini CLI",
        binary: "gemini",
        environmentVariable: "BROWSER_TESTBENCH_GEMINI_PATH",
        statusArgs: ["mcp", "list"],
        addArgs: ["mcp", "add", "--scope", "user", PackageMetadata.NAME, ...stdioCommand],
        removeArgs: ["mcp", "remove", "--scope", "user", PackageMetadata.NAME],
        instruction: { key: "mcp.geminiInstruction" },
      },
      {
        id: "copilot-vscode",
        label: "GitHub Copilot in VS Code",
        binary: "code",
        environmentVariable: "BROWSER_TESTBENCH_CODE_PATH",
        command: TestbenchPaths.shellCommand(["code", "--add-mcp", vscodeConfig]),
        instruction: { key: "mcp.copilotInstruction" },
      },
      {
        id: "other",
        label: "Other MCP client",
        format: "json",
        instruction: { key: "mcp.otherInstruction" },
      },
    ];
  }

  private static registrationStatusKey(current: boolean, registered: boolean) {
    if (current) return "mcp.current" as const;
    if (registered) return "mcp.outdated" as const;
    return "mcp.notConnected" as const;
  }

  private static definition(id: McpClientId): McpClientDefinition {
    const definition = this.definitions().find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Unknown MCP client: ${id}`);
    return definition;
  }

  private static setupValue(definition: McpClientDefinition): string {
    if (definition.command) return definition.command;
    if (!definition.binary) {
      const launcher = McpServerLauncher.command();
      return JSON.stringify(
        {
          mcpServers: {
            [PackageMetadata.NAME]: {
              command: launcher.command,
              args: launcher.args,
            },
          },
        },
        null,
        2,
      );
    }
    return TestbenchPaths.shellCommand([definition.binary, ...(definition.addArgs ?? [])]);
  }

  private static usesManagedLauncher(stdout: string, output: string): boolean {
    try {
      if (this.containsManagedLauncher(JSON.parse(stdout))) return true;
    } catch {
      // Some MCP clients return human-readable status output instead of JSON.
    }
    return output.includes(`${PackageMetadata.NAME}@latest`) && output.includes("mcp");
  }

  private static containsManagedLauncher(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.args) && this.isManagedLauncherArgs(record.args)) return true;
    }
    return Object.values(value).some((entry) => this.containsManagedLauncher(entry));
  }

  private static isManagedLauncherArgs(args: unknown[]): boolean {
    const values = args.filter((value): value is string => typeof value === "string");
    const packageIndex = values.indexOf(`${PackageMetadata.NAME}@latest`);
    return packageIndex >= 0 && values[packageIndex + 1] === "mcp";
  }
}
