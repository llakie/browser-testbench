import { X509Certificate } from "node:crypto";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";

const SIGNING_CHECK_TIMEOUT_MS = 5_000;
const CREATE_IDENTITY_PROBLEM =
  "No Apple Development signing identity is available. In Xcode Settings → Accounts, select your team, open Manage Certificates, create an Apple Development certificate, then check again.";

export interface IosSigningIdentity {
  name: string;
  teamId: string;
}

export interface IosSigningConfiguration extends IosSigningIdentity {
  bundleId: string;
}

export class IosSigningService {
  static async configuration(
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<{ selected?: IosSigningConfiguration; identities: IosSigningIdentity[]; problem?: string }> {
    const result = await CommandRunner.run("security", ["find-identity", "-v", "-p", "codesigning"], {
      timeoutMs: SIGNING_CHECK_TIMEOUT_MS,
    });
    const identities = result.code === 0 ? await this.resolveTeamIds(this.parseIdentities(result.stdout)) : [];
    const requestedTeam = environment.BROWSER_TESTBENCH_IOS_TEAM_ID?.trim();
    if (requestedTeam) {
      const identity = identities.find((candidate) => candidate.teamId === requestedTeam);
      if (!identity) {
        return {
          identities,
          problem: `BROWSER_TESTBENCH_IOS_TEAM_ID is set to ${requestedTeam}, but no matching Apple Development signing identity is available.`,
        };
      }
      return { identities, selected: this.withBundleId(identity) };
    }
    if (identities.length === 1) return { identities, selected: this.withBundleId(identities[0]!) };
    if (identities.length > 1) {
      return {
        identities,
        problem:
          "Multiple Apple Development teams are available. Set BROWSER_TESTBENCH_IOS_TEAM_ID to the team that should sign WebDriverAgent.",
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

  private static async unavailableIdentityProblem(): Promise<string> {
    const matching = await CommandRunner.run("security", ["find-identity", "-p", "codesigning"], {
      timeoutMs: SIGNING_CHECK_TIMEOUT_MS,
    });
    if (matching.code === 0 && this.parseIdentities(matching.stdout).length > 0) {
      return "An Apple Development certificate and private key are present, but macOS does not trust the signing identity. Check the certificate status and install Apple's Worldwide Developer Relations G3 intermediate certificate.";
    }
    const certificate = await CommandRunner.run(
      "security",
      ["find-certificate", "-a", "-c", "Apple Development", "-p"],
      { timeoutMs: SIGNING_CHECK_TIMEOUT_MS },
    );
    if (certificate.code === 0 && certificate.stdout.trim()) {
      return "An Apple Development certificate is present without its matching private key. In Keychain Access, select login → My Certificates and recreate or import the identity through Xcode.";
    }
    return CREATE_IDENTITY_PROBLEM;
  }
}
