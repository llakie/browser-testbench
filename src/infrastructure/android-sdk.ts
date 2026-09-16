import { access } from "node:fs/promises";
import { join } from "node:path";

export class AndroidSdk {
  static async root(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): Promise<string | undefined> {
    for (const path of this.candidates(env, platform)) {
      try {
        await access(path);
        return path;
      } catch {
        // Try the next conventional SDK location.
      }
    }
    return undefined;
  }

  static environment(root: string): NodeJS.ProcessEnv {
    return { ANDROID_HOME: root, ANDROID_SDK_ROOT: root };
  }

  static executableName(
    name: string,
    windowsExtension: ".exe" | ".bat" = ".exe",
    platform: NodeJS.Platform = process.platform,
  ): string {
    return platform === "win32" ? `${name}${windowsExtension}` : name;
  }

  private static candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
    const home = env.HOME ?? env.USERPROFILE ?? "";
    return [
      env.ANDROID_HOME,
      env.ANDROID_SDK_ROOT,
      platform === "darwin" ? join(home, "Library", "Android", "sdk") : undefined,
      platform === "win32" ? join(env.LOCALAPPDATA ?? home, "Android", "Sdk") : undefined,
      platform === "linux" ? join(home, "Android", "Sdk") : undefined,
    ].filter((value): value is string => Boolean(value));
  }
}
