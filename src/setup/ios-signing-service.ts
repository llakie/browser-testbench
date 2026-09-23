import { X509Certificate } from "node:crypto";
import type { TranslatableText } from "../i18n/translator.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

const SIGNING_CHECK_TIMEOUT_MS = 5_000;

export interface IosSigningIdentity {
  name: string;
  teamId: string;
}

export interface IosSigningConfiguration extends IosSigningIdentity {
  bundleId: string;
}

export interface IosSigningStatus {
  selected?: IosSigningConfiguration;
  identities: IosSigningIdentity[];
  problem?: TranslatableText;
}

export class IosSigningService {
  static async configuration(environment: NodeJS.ProcessEnv = process.env): Promise<IosSigningStatus> {
    const result = await CommandRunner.run("security", ["find-identity", "-v", "-p", "codesigning"], {
      timeoutMs: SIGNING_CHECK_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      return {
        identities: [],
        problem: {
          key: "environment.iosSigningCheckFailed",
          parameters: { reason: this.commandDiagnostic(result) },
        },
      };
    }
    const identities = await this.resolveTeamIds(this.parseIdentities(result.stdout));
    const requestedTeam = environment.BROWSER_TESTBENCH_IOS_TEAM_ID?.trim();
    if (requestedTeam) {
      const identity = identities.find((candidate) => candidate.teamId === requestedTeam);
      if (!identity) {
        return {
          identities,
          problem: {
            key: "environment.iosSigningTeamMissing",
            parameters: { teamId: requestedTeam },
          },
        };
      }
      return { identities, selected: this.withBundleId(identity) };
    }
    if (identities.length === 1) return { identities, selected: this.withBundleId(identities[0]!) };
    if (identities.length > 1) {
      return {
        identities,
        problem: { key: "environment.iosSigningMultipleTeams" },
      };
    }
    return {
      identities,
      problem: await this.unavailableIdentityProblem(),
    };
  }

  static parseIdentities(output: string): IosSigningIdentity[] {
    const identities = output.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/"((?:Apple Development|iPhone Developer)[^"]*)\s\(([A-Z0-9]{10})\)"/u);
      return match ? [{ name: match[1]!, teamId: match[2]! }] : [];
    });
    return [...new Map(identities.map((identity) => [identity.teamId, identity])).values()];
  }

  static parseCertificateTeamId(subject: string): string | undefined {
    return subject.match(/(?:^|\n)OU=([A-Z0-9]{10})(?:\n|$)/u)?.[1];
  }

  static openWdaCommand(): string {
    return TestbenchPaths.shellCommand([
      "env",
      `APPIUM_HOME=${TestbenchPaths.data("appium")}`,
      process.execPath,
      TestbenchPaths.packageBinary("appium"),
      "driver",
      "run",
      "xcuitest",
      "open-wda",
    ]);
  }

  private static withBundleId(identity: IosSigningIdentity): IosSigningConfiguration {
    return {
      ...identity,
      bundleId: `com.browser-testbench.WebDriverAgentRunner.${identity.teamId.toLowerCase()}`,
    };
  }

  private static async resolveTeamIds(identities: IosSigningIdentity[]): Promise<IosSigningIdentity[]> {
    const resolved = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        teamId: (await this.certificateTeamId(identity)) ?? identity.teamId,
      })),
    );
    return [...new Map(resolved.map((identity) => [identity.teamId, identity])).values()];
  }

  private static async certificateTeamId(identity: IosSigningIdentity): Promise<string | undefined> {
    const commonName = `${identity.name} (${identity.teamId})`;
    const result = await CommandRunner.run("security", ["find-certificate", "-c", commonName, "-p"], {
      timeoutMs: SIGNING_CHECK_TIMEOUT_MS,
    });
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    try {
      return this.parseCertificateTeamId(new X509Certificate(result.stdout).subject);
    } catch {
      return undefined;
    }
  }

  private static async unavailableIdentityProblem(): Promise<TranslatableText> {
    const matching = await CommandRunner.run("security", ["find-identity", "-p", "codesigning"], {
      timeoutMs: SIGNING_CHECK_TIMEOUT_MS,
    });
    if (matching.code === 0 && this.parseIdentities(matching.stdout).length > 0) {
      return { key: "environment.iosSigningUntrusted" };
    }
    if (matching.code === -1) {
      return {
        key: "environment.iosSigningCheckFailed",
        parameters: { reason: this.commandDiagnostic(matching) },
      };
    }
    const certificate = await CommandRunner.run(
      "security",
      ["find-certificate", "-a", "-c", "Apple Development", "-p"],
      { timeoutMs: SIGNING_CHECK_TIMEOUT_MS },
    );
    if (certificate.code === 0 && certificate.stdout.trim()) {
      return { key: "environment.iosSigningPrivateKeyMissing" };
    }
    if (certificate.code === -1) {
      return {
        key: "environment.iosSigningCheckFailed",
        parameters: { reason: this.commandDiagnostic(certificate) },
      };
    }
    return { key: "environment.iosSigningIdentityMissing" };
  }

  private static commandDiagnostic(result: { code: number; stdout: string; stderr: string }): string {
    return result.stderr.trim() || result.stdout.trim() || `security exited with code ${result.code}`;
  }
}
