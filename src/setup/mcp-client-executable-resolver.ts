import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { CommandRunner } from "../infrastructure/command-runner.js";

const EXECUTABLE_CHECK_TIMEOUT_MS = 5_000;

export type ExecutableMcpClientId = "codex" | "claude-code" | "gemini-cli" | "copilot-vscode";

export interface McpClientExecutableDefinition {
  id: ExecutableMcpClientId;
  binary: string;
  environmentVariable: string;
  versionArgs?: string[];
}

export interface ResolvedMcpClientExecutable {
  command: string;
  source: "environment" | "path" | "user" | "ide";
}

interface ResolutionContext {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
}

export class McpClientExecutableResolver {
  static async resolve(
    definition: McpClientExecutableDefinition,
    context: ResolutionContext = {},
  ): Promise<ResolvedMcpClientExecutable | undefined> {
    const environment = context.environment ?? process.env;
    const override = environment[definition.environmentVariable]?.trim();
    const candidates = override
      ? [{ command: override, source: "environment" as const }]
      : this.candidates(definition, context);

    for (const candidate of candidates) {
      const result = await CommandRunner.run(candidate.command, definition.versionArgs ?? ["--version"], {
        timeoutMs: EXECUTABLE_CHECK_TIMEOUT_MS,
      });
      if (result.code === 0) return candidate;
    }
    return undefined;
  }

  static candidates(
    definition: McpClientExecutableDefinition,
    context: ResolutionContext = {},
  ): ResolvedMcpClientExecutable[] {
    const platform = context.platform ?? process.platform;
    const environment = context.environment ?? process.env;
    const home = context.home ?? homedir();
    const executableName = platform === "win32" ? `${definition.binary}.exe` : definition.binary;
    const pathExecutableName = platform === "win32" ? `${definition.binary}.cmd` : definition.binary;
    const candidates: ResolvedMcpClientExecutable[] = [
      { command: definition.binary, source: "path" },
      ...this.pathCandidates(pathExecutableName, environment),
      ...this.userCandidates(executableName, pathExecutableName, platform, environment, home),
    ];

    if (definition.id === "codex") {
      candidates.push(...this.codexIdeCandidates(executableName, home));
    }
    if (definition.id === "copilot-vscode") {
      candidates.push(...this.vsCodeCandidates(platform, environment, home));
    }

    return this.unique(candidates);
  }

  private static pathCandidates(executableName: string, environment: NodeJS.ProcessEnv): ResolvedMcpClientExecutable[] {
    return (environment.PATH ?? environment.Path ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => ({ command: join(directory, executableName), source: "path" as const }))
      .filter(({ command }) => existsSync(command));
  }

  private static userCandidates(
    executableName: string,
    pathExecutableName: string,
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    home: string,
  ): ResolvedMcpClientExecutable[] {
    if (platform === "win32") {
      const appData = environment.APPDATA ?? join(home, "AppData", "Roaming");
      return [
        { command: join(appData, "npm", pathExecutableName), source: "user" },
        { command: join(home, ".local", "bin", executableName), source: "user" },
      ].filter(({ command }) => existsSync(command)) as ResolvedMcpClientExecutable[];
    }

    return [
      { command: join(home, ".local", "bin", executableName), source: "user" },
      { command: join(home, "bin", executableName), source: "user" },
    ].filter(({ command }) => existsSync(command)) as ResolvedMcpClientExecutable[];
  }

  private static codexIdeCandidates(executableName: string, home: string): ResolvedMcpClientExecutable[] {
    const extensionRoots = [join(home, ".vscode", "extensions"), join(home, ".vscode-insiders", "extensions")];
    const candidates: ResolvedMcpClientExecutable[] = [];

    for (const root of extensionRoots) {
      if (!existsSync(root)) continue;
      const extensions = readdirSync(root)
        .filter((entry) => entry.startsWith("openai.chatgpt-"))
        .sort()
        .reverse();
      for (const extension of extensions) {
        const binaryRoot = join(root, extension, "bin");
        if (!existsSync(binaryRoot)) continue;
        for (const platformDirectory of readdirSync(binaryRoot)) {
          const command = join(binaryRoot, platformDirectory, executableName);
          if (existsSync(command)) candidates.push({ command, source: "ide" });
        }
      }
    }
    return candidates;
  }

  private static vsCodeCandidates(
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    home: string,
  ): ResolvedMcpClientExecutable[] {
    const paths =
      platform === "darwin"
        ? [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            join(home, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"),
          ]
        : platform === "win32"
          ? [
              join(
                environment.LOCALAPPDATA ?? join(home, "AppData", "Local"),
                "Programs",
                "Microsoft VS Code",
                "bin",
                "code.cmd",
              ),
            ]
          : ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"];

    return paths.filter((command) => existsSync(command)).map((command) => ({ command, source: "ide" as const }));
  }

  private static unique(candidates: ResolvedMcpClientExecutable[]): ResolvedMcpClientExecutable[] {
    return candidates.filter(
      (candidate, index) => candidates.findIndex((entry) => entry.command === candidate.command) === index,
    );
  }
}
