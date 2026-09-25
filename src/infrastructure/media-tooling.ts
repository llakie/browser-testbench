import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export class MediaTooling {
  static readonly EXECUTABLES = ["ffmpeg", "ffprobe"] as const;

  static isAvailable(
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): boolean {
    return this.missing(environment, platform).length === 0;
  }

  static missing(
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): (typeof this.EXECUTABLES)[number][] {
    return this.EXECUTABLES.filter((name) => !this.has(name, environment, platform));
  }

  static installationCommand(
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): string | undefined {
    if (platform === "darwin") return this.has("brew", environment, platform) ? "brew install ffmpeg" : undefined;
    if (platform === "win32")
      return this.has("winget", environment, platform) ? "winget install --id Gyan.FFmpeg --exact" : undefined;
    const managers = [
      ["apt-get", "sudo apt-get install ffmpeg"],
      ["dnf", "sudo dnf install ffmpeg"],
      ["yum", "sudo yum install ffmpeg"],
      ["pacman", "sudo pacman -S ffmpeg"],
      ["zypper", "sudo zypper install ffmpeg"],
      ["apk", "sudo apk add ffmpeg"],
    ] as const;
    return managers.find(([executable]) => this.has(executable, environment, platform))?.[1];
  }

  private static has(name: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
    const candidates = (environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, platform === "win32" ? `${name}.exe` : name));
    return candidates.some((path) => {
      if (!existsSync(path)) return false;
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
}
