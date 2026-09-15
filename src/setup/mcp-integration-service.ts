import { join } from "node:path";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

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
        detail: "Konfiguration zum Kopieren bereit.",
        instruction: definition.instruction,
      };
    }

    const version = await CommandRunner.run(definition.binary, definition.versionArgs ?? ["--version"], {
      timeoutMs: 5_000,
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
        detail: `${definition.label} wurde auf diesem Rechner nicht gefunden.`,
        instruction: definition.instruction,
      };
    }

    const registration = await CommandRunner.run(definition.binary, definition.statusArgs ?? [], { timeoutMs: 8_000 });
    const output = `${registration.stdout}\n${registration.stderr}`;
    const registered = output.includes("browser-testbench");
    const current = registration.code === 0 && registered && output.includes(this.cliPath());
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
        ? "Verbunden und einsatzbereit."
        : registered
          ? "Verbunden, aber mit einer anderen Testbench-Installation."
          : "Noch nicht mit der Testbench verbunden.",
      instruction: definition.instruction,
    };
  }

  static async register(id: AutomaticMcpClientId): Promise<McpIntegrationStatus> {
    const definition = this.definition(id);
    const existing = await this.status(id);
    if (!existing.installed) throw new Error(`${definition.label} wurde auf diesem Rechner nicht gefunden.`);
    if (existing.current) return existing;
    if (existing.registered) {
      const removed = await CommandRunner.run(definition.binary!, definition.removeArgs!, { timeoutMs: 8_000 });
      if (removed.code !== 0) {
        throw new Error(
          removed.stderr.trim() || `Die vorhandene Verbindung zu ${definition.label} konnte nicht entfernt werden.`,
        );
      }
    }
    const added = await CommandRunner.run(definition.binary!, definition.addArgs!, { timeoutMs: 15_000 });
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || `Die Verbindung zu ${definition.label} konnte nicht eingerichtet werden.`);
    }
    return this.status(id);
  }

  private static definitions(): McpClientDefinition[] {
    const cli = this.cliPath();
    const stdioArgs = [cli, "mcp"];
    const vscodeConfig = JSON.stringify({ name: "browser-testbench", command: "node", args: stdioArgs });
    return [
      {
        id: "codex",
        label: "Codex",
        binary: "codex",
        statusArgs: ["mcp", "get", "browser-testbench", "--json"],
        addArgs: ["mcp", "add", "browser-testbench", "--", "node", ...stdioArgs],
        removeArgs: ["mcp", "remove", "browser-testbench"],
        instruction: "Die Verbindung gilt benutzerweit und steht dadurch in allen Projekten zur Verfügung.",
      },
      {
        id: "claude-code",
        label: "Claude Code",
        binary: "claude",
        statusArgs: ["mcp", "get", "browser-testbench"],
        addArgs: [
          "mcp",
          "add",
          "--transport",
          "stdio",
          "--scope",
          "user",
          "browser-testbench",
          "--",
          "node",
          ...stdioArgs,
        ],
        removeArgs: ["mcp", "remove", "browser-testbench", "--scope", "user"],
        instruction: "Die Verbindung wird im benutzerweiten Claude-Code-Profil eingerichtet.",
      },
      {
        id: "gemini-cli",
        label: "Gemini CLI",
        binary: "gemini",
        statusArgs: ["mcp", "list"],
        addArgs: ["mcp", "add", "--scope", "user", "browser-testbench", "node", ...stdioArgs],
        removeArgs: ["mcp", "remove", "--scope", "user", "browser-testbench"],
        instruction: "Die Verbindung wird im benutzerweiten Gemini-CLI-Profil eingerichtet.",
      },
      {
        id: "copilot-vscode",
        label: "GitHub Copilot in VS Code",
        command: TestbenchPaths.shellCommand(["code", "--add-mcp", vscodeConfig]),
        instruction: "Führe den Befehl aus und bestätige den neuen MCP-Server anschließend in VS Code.",
      },
      {
        id: "other",
        label: "Anderer MCP-Client",
        format: "json",
        instruction: "Übernimm diesen lokalen Standard-MCP-Eintrag in die Konfiguration deines Clients.",
      },
    ];
  }

  private static definition(id: McpClientId): McpClientDefinition {
    const definition = this.definitions().find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Unbekannter MCP-Client: ${id}`);
    return definition;
  }

  private static setupValue(definition: McpClientDefinition): string {
    if (definition.command) return definition.command;
    if (!definition.binary) {
      return JSON.stringify(
        {
          mcpServers: {
            "browser-testbench": {
              command: "node",
              args: [this.cliPath(), "mcp"],
            },
          },
        },
        null,
        2,
      );
    }
    return TestbenchPaths.shellCommand([definition.binary, ...(definition.addArgs ?? [])]);
  }

  private static cliPath(): string {
    return join(TestbenchPaths.projectRoot, "dist", "cli.js");
  }
}
