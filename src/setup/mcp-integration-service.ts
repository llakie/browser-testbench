import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { PackageMetadata } from "../config/package-metadata.js";

const CLIENT_DETECTION_TIMEOUT_MS = 5_000;
const REGISTRATION_STATUS_TIMEOUT_MS = 8_000;
const REGISTRATION_UPDATE_TIMEOUT_MS = 15_000;

export type McpClientId = "codex" | "claude-code" | "gemini-cli" | "copilot-vscode" | "other";
export type AutomaticMcpClientId = Extract<McpClientId, "codex" | "claude-code" | "gemini-cli">;

export interface McpIntegrationStatus {
  id: McpClientId;
  label: string;
  installed: boolean;
  automatic: boolean;
  registered: boolean;
  current: boolean;
  command: string;
  format: "command" | "json";
  detail: string;
  instruction: string;
}

interface McpClientDefinition {
  id: McpClientId;
  label: string;
  binary?: string;
  versionArgs?: string[];
  statusArgs?: string[];
  addArgs?: string[];
  removeArgs?: string[];
  command?: string;
  format?: "command" | "json";
  instruction: string;
}

export class McpIntegrationService {
  static async statuses(): Promise<McpIntegrationStatus[]> {
    return Promise.all(this.definitions().map((definition) => this.status(definition.id)));
  }

  static async status(id: McpClientId): Promise<McpIntegrationStatus> {
    const definition = this.definition(id);
    const command = this.setupValue(definition);
    if (!definition.binary) {
      return {
        id,
        label: definition.label,
        installed: true,
        automatic: false,
        registered: false,
        current: false,
        command,
        format: definition.format ?? "command",
        detail: "Configuration ready to copy.",
        instruction: definition.instruction,
      };
    }

    const version = await CommandRunner.run(definition.binary, definition.versionArgs ?? ["--version"], {
      timeoutMs: CLIENT_DETECTION_TIMEOUT_MS,
    });
    if (version.code !== 0) {
      return {
        id,
        label: definition.label,
        installed: false,
        automatic: false,
        registered: false,
        current: false,
        command,
        format: "command",
        detail: `${definition.label} was not found on this machine.`,
        instruction: definition.instruction,
      };
    }

    const registration = await CommandRunner.run(definition.binary, definition.statusArgs ?? [], {
      timeoutMs: REGISTRATION_STATUS_TIMEOUT_MS,
    });
    const output = `${registration.stdout}\n${registration.stderr}`;
    const registered = output.includes(PackageMetadata.NAME);
    const current = registration.code === 0 && registered && this.usesPortableCommand(registration.stdout, output);
    return {
      id,
      label: definition.label,
      installed: true,
      automatic: id === "codex" || id === "claude-code" || id === "gemini-cli",
      registered,
      current,
      command,
      format: "command",
      detail: current
        ? "Connected and ready."
        : registered
          ? "Connected, but to a different Browser Testbench installation."
          : "Not connected to Browser Testbench yet.",
      instruction: definition.instruction,
    };
  }

  static async register(id: AutomaticMcpClientId): Promise<McpIntegrationStatus> {
    const definition = this.definition(id);
    const existing = await this.status(id);
    if (!existing.installed) throw new Error(`${definition.label} was not found on this machine.`);
    if (existing.current) return existing;
    if (existing.registered) {
      const removed = await CommandRunner.run(definition.binary!, definition.removeArgs!, {
        timeoutMs: REGISTRATION_STATUS_TIMEOUT_MS,
      });
      if (removed.code !== 0) {
        throw new Error(
          removed.stderr.trim() || `The existing connection to ${definition.label} could not be removed.`,
        );
      }
    }
    const added = await CommandRunner.run(definition.binary!, definition.addArgs!, {
      timeoutMs: REGISTRATION_UPDATE_TIMEOUT_MS,
    });
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || `The connection to ${definition.label} could not be set up.`);
    }
    return this.status(id);
  }

  private static definitions(): McpClientDefinition[] {
    const stdioCommand = [PackageMetadata.NAME, "mcp"];
    const vscodeConfig = JSON.stringify({ name: PackageMetadata.NAME, command: stdioCommand[0], args: ["mcp"] });
    return [
      {
        id: "codex",
        label: "Codex",
        binary: "codex",
        statusArgs: ["mcp", "get", PackageMetadata.NAME, "--json"],
        addArgs: ["mcp", "add", PackageMetadata.NAME, "--", ...stdioCommand],
        removeArgs: ["mcp", "remove", PackageMetadata.NAME],
        instruction: "The connection is user-wide and therefore available in every project.",
      },
      {
        id: "claude-code",
        label: "Claude Code",
        binary: "claude",
        statusArgs: ["mcp", "get", PackageMetadata.NAME],
        addArgs: ["mcp", "add", "--transport", "stdio", "--scope", "user", PackageMetadata.NAME, "--", ...stdioCommand],
        removeArgs: ["mcp", "remove", PackageMetadata.NAME, "--scope", "user"],
        instruction: "The connection is added to the user-wide Claude Code profile.",
      },
      {
        id: "gemini-cli",
        label: "Gemini CLI",
        binary: "gemini",
        statusArgs: ["mcp", "list"],
        addArgs: ["mcp", "add", "--scope", "user", PackageMetadata.NAME, ...stdioCommand],
        removeArgs: ["mcp", "remove", "--scope", "user", PackageMetadata.NAME],
        instruction: "The connection is added to the user-wide Gemini CLI profile.",
      },
      {
        id: "copilot-vscode",
        label: "GitHub Copilot in VS Code",
        command: TestbenchPaths.shellCommand(["code", "--add-mcp", vscodeConfig]),
        instruction: "Run the command, then confirm the new MCP server in VS Code.",
      },
      {
        id: "other",
        label: "Other MCP client",
        format: "json",
        instruction: "Add this standard local MCP entry to your client's configuration.",
      },
    ];
  }

  private static definition(id: McpClientId): McpClientDefinition {
    const definition = this.definitions().find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Unknown MCP client: ${id}`);
    return definition;
  }

  private static setupValue(definition: McpClientDefinition): string {
    if (definition.command) return definition.command;
    if (!definition.binary) {
      return JSON.stringify(
        {
          mcpServers: {
            [PackageMetadata.NAME]: {
              command: PackageMetadata.NAME,
              args: ["mcp"],
            },
          },
        },
        null,
        2,
      );
    }
    return TestbenchPaths.shellCommand([definition.binary, ...(definition.addArgs ?? [])]);
  }

  private static usesPortableCommand(stdout: string, output: string): boolean {
    try {
      if (this.containsPortableCommand(JSON.parse(stdout))) return true;
    } catch {
      // Some MCP clients return human-readable status output instead of JSON.
    }
    return output.includes(`${PackageMetadata.NAME} mcp`);
  }

  private static containsPortableCommand(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.command === PackageMetadata.NAME && Array.isArray(record.args) && record.args[0] === "mcp")
        return true;
    }
    return Object.values(value).some((entry) => this.containsPortableCommand(entry));
  }
}
