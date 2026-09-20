import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { TargetRegistry } from "../config/target-registry.js";
import { AndroidSdk } from "../infrastructure/android-sdk.js";
import { CommandRunner } from "../infrastructure/command-runner.js";
import { TestbenchPaths } from "../infrastructure/paths.js";
import { AndroidDeviceService } from "./android-device-service.js";
import type { SetupAction } from "./setup-types.js";

const SDK_COMMAND_TIMEOUT_MS = 8_000;
const AVD_CREATE_TIMEOUT_MS = 60_000;
const GOOGLE_PLAY_TAG_PREFIX = "google_apis_playstore";
const AVD_NAME_PREFIX = "browser-testbench";

export interface AndroidSystemImage {
  apiLevel: string;
  architecture: "arm64-v8a" | "x86_64";
  packageId: string;
  tag: string;
}

interface AndroidAvdEnvironment {
  sdkRoot: string;
  avdManager?: string;
  compatibleNames: string[];
}

interface AndroidAvdCandidate {
  action: SetupAction;
  image?: AndroidSystemImage;
  profile?: string;
}

export class AndroidAvdService {
  static async plan(): Promise<SetupAction | undefined> {
    const environment = await this.environment();
    if (!environment) return undefined;
    if (environment.compatibleNames.length > 0) return undefined;
    return (await this.provisioningCandidate(environment)).action;
  }

  static async ensure(onOutput?: (line: string) => void): Promise<SetupAction> {
    const environment = await this.environment();
    if (!environment) {
      return {
        id: "android-sdk",
        label: TargetRegistry.definitions["chrome-android"].label,
        automatic: false,
        status: "manual",
        detail: "Install the Android SDK and Android Emulator, then run setup again.",
        messages: { detail: { key: "environment.avdInstallSdk" } },
      };
    }
    if (environment.compatibleNames.length > 0) {
      return {
        id: "android-avd",
        label: "Android Virtual Device",
        automatic: true,
        status: "completed",
        detail: `Using existing compatible AVD ${environment.compatibleNames[0]}.`,
        messages: {
          label: { key: "environment.avdLabel" },
          detail: { key: "environment.avdExisting", parameters: { name: environment.compatibleNames[0]! } },
        },
      };
    }

    const candidate = await this.provisioningCandidate(environment);
    const { action, image, profile } = candidate;
    if (action.status === "manual" || !environment.avdManager || !image || !profile) return action;

    const name = this.avdName(profile, image.apiLevel);
    onOutput?.(`Creating Android AVD ${name} from installed image ${image.packageId} …`);
    const created = await CommandRunner.run(
      environment.avdManager,
      ["create", "avd", "--name", name, "--package", image.packageId, "--device", profile, "--force"],
      {
        env: { ...process.env, ...AndroidSdk.environment(environment.sdkRoot) },
        input: "no\n",
        timeoutMs: AVD_CREATE_TIMEOUT_MS,
      },
    );
    return {
      id: "android-avd",
      label: `Android AVD ${name}`,
      automatic: true,
      status: created.code === 0 ? "completed" : "failed",
      detail:
        created.code === 0
          ? `Created from ${image.packageId} with hardware profile ${profile}.`
          : (created.stderr || created.stdout).trim(),
      ...(created.code === 0
        ? {
            messages: {
              detail: {
                key: "environment.avdCreated" as const,
                parameters: { image: image.packageId, profile },
              },
            },
          }
        : {}),
    };
  }

  static async installedSystemImages(
    sdkRoot: string,
    architecture: AndroidSystemImage["architecture"] = this.hostArchitecture(),
  ): Promise<AndroidSystemImage[]> {
    const root = join(sdkRoot, "system-images");
    const images: AndroidSystemImage[] = [];
    for (const platform of await this.directories(root)) {
      const apiLevel = platform.match(/^android-(\d+(?:\.\d+)*)$/)?.[1];
      if (!apiLevel) continue;
      for (const tag of await this.directories(join(root, platform))) {
        if (!tag.startsWith(GOOGLE_PLAY_TAG_PREFIX)) continue;
        const imageRoot = join(root, platform, tag, architecture);
        if (!(await this.exists(join(imageRoot, "source.properties")))) continue;
        images.push({
          apiLevel,
          architecture,
          packageId: `system-images;${platform};${tag};${architecture}`,
          tag,
        });
      }
    }
    return images.sort((left, right) => {
      const version = this.compareVersions(right.apiLevel, left.apiLevel);
      if (version !== 0) return version;
      if (left.tag === GOOGLE_PLAY_TAG_PREFIX) return -1;
      if (right.tag === GOOGLE_PLAY_TAG_PREFIX) return 1;
      return left.tag.localeCompare(right.tag);
    });
  }

  static selectPixelProfile(output: string): string | undefined {
    const profiles = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^pixel(?:_|$)/i.test(line));
    const numbered = profiles
      .map((profile) => ({ profile, generation: Number(profile.match(/^pixel_(\d+)$/i)?.[1] ?? -1) }))
      .filter(({ generation }) => generation >= 0)
      .sort((left, right) => right.generation - left.generation);
    return numbered[0]?.profile ?? profiles.find((profile) => profile.toLowerCase() === "pixel") ?? profiles[0];
  }

  static avdName(profile: string, apiLevel: string): string {
    const normalizedProfile = profile
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const normalizedApi = apiLevel.replace(/[^0-9]+/g, "-").replace(/^-|-$/g, "");
    return `${AVD_NAME_PREFIX}-${normalizedProfile}-api-${normalizedApi}`;
  }

  static hostArchitecture(architecture: string = process.arch): AndroidSystemImage["architecture"] {
    return architecture === "arm64" ? "arm64-v8a" : "x86_64";
  }

  private static async provisioningCandidate(environment: AndroidAvdEnvironment): Promise<AndroidAvdCandidate> {
    if (!environment.avdManager) {
      return {
        action: {
          id: "android-command-line-tools",
          label: "Android Virtual Device",
          automatic: false,
          status: "manual",
          detail: "Install the Android SDK Command-line Tools, then run setup again.",
          messages: {
            label: { key: "environment.avdLabel" },
            detail: { key: "environment.avdCommandTools" },
          },
        },
      };
    }
    const image = (await this.installedSystemImages(environment.sdkRoot))[0];
    if (!image) {
      const architecture = this.hostArchitecture();
      return {
        action: {
          id: "android-system-image",
          label: "Google Play system image",
          automatic: false,
          status: "manual",
          detail: `No compatible Google Play system image for ${architecture} is installed. Install the latest available image in Android Studio > SDK Manager, then run setup again.`,
          messages: {
            label: { key: "environment.avdImageLabel" },
            detail: { key: "environment.avdImageMissing", parameters: { architecture } },
          },
        },
      };
    }
    const profiles = await CommandRunner.run(environment.avdManager, ["list", "device", "--compact"], {
      env: { ...process.env, ...AndroidSdk.environment(environment.sdkRoot) },
      timeoutMs: SDK_COMMAND_TIMEOUT_MS,
    });
    const profile = profiles.code === 0 ? this.selectPixelProfile(profiles.stdout) : undefined;
    if (!profile) {
      return {
        action: {
          id: "android-hardware-profile",
          label: "Pixel hardware profile",
          automatic: false,
          status: "manual",
          detail:
            "No Pixel hardware profile is available. Install or create one in Android Studio, then run setup again.",
          messages: {
            label: { key: "environment.avdProfileLabel" },
            detail: { key: "environment.avdProfileMissing" },
          },
        },
      };
    }
    const name = this.avdName(profile, image.apiLevel);
    return {
      action: {
        id: "android-avd",
        label: `Android AVD ${name}`,
        automatic: true,
        status: "planned",
        command: TestbenchPaths.cliCommand("setup", "--yes", "--targets", "chrome-android"),
        detail: `Create ${name} from ${image.packageId} with hardware profile ${profile}.`,
        messages: {
          detail: {
            key: "environment.avdCreate",
            parameters: { name, image: image.packageId, profile },
          },
        },
      },
      image,
      profile,
    };
  }

  private static async environment(): Promise<AndroidAvdEnvironment | undefined> {
    const sdkRoot = await AndroidSdk.root();
    if (!sdkRoot) return undefined;
    const emulator = join(sdkRoot, "emulator", AndroidSdk.executableName("emulator"));
    if (!(await this.exists(emulator))) return undefined;
    const listed = await CommandRunner.run(emulator, ["-list-avds"], {
      env: { ...process.env, ...AndroidSdk.environment(sdkRoot) },
      timeoutMs: SDK_COMMAND_TIMEOUT_MS,
    });
    const names = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const options = await AndroidDeviceService.avdOptions(names);
    return {
      sdkRoot,
      compatibleNames: options.filter((option) => option.compatible).map((option) => option.name),
      avdManager: await this.findSdkTool(sdkRoot, "avdmanager"),
    };
  }

  private static async findSdkTool(sdkRoot: string, name: string): Promise<string | undefined> {
    const commandLineTools = join(sdkRoot, "cmdline-tools");
    try {
      const entries = await readdir(commandLineTools, { recursive: true });
      const executable = AndroidSdk.executableName(name, ".bat");
      const relative = entries.find((entry) => basename(entry) === executable && entry.includes("bin"));
      return relative ? join(commandLineTools, relative) : undefined;
    } catch {
      return undefined;
    }
  }

  private static async directories(path: string): Promise<string[]> {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private static compareVersions(left: string, right: string): number {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }

  private static async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
