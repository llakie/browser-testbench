import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export class MediaTooling {
  static isAvailable(
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): boolean {
    return this.has("ffmpeg", environment, platform) && this.has("ffprobe", environment, platform);
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
