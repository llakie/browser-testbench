import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { StartSessionInput } from "../config/input-schemas.js";
import type { InteractiveController } from "../automation/interactive-controller.js";

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

interface TransferredFile {
  name: string;
  base64: string;
}

interface LocalArtifactPaths {
  downloadDir?: string;
  videoPath?: string;
}

export class RemoteArtifactGateway {
  private readonly sessions = new Map<string, LocalArtifactPaths>();

  prepareSession(input: StartSessionInput): Record<string, unknown> {
    if (!input.downloadDir && !input.videoPath) return input;
    return { ...input, transferArtifacts: true };
  }

  trackSession(sessionId: string, input: StartSessionInput): void {
    if (input.downloadDir || input.videoPath)
      this.sessions.set(sessionId, { downloadDir: input.downloadDir, videoPath: input.videoPath });
  }

  async uploadBody(body: {
    selector: string;
    paths: string[];
  }): Promise<{ selector: string; files: TransferredFile[] }> {
    let totalSize = 0;
    const files: TransferredFile[] = [];
    for (const path of body.paths) {
      const content = await readFile(path);
      totalSize += content.byteLength;
      this.assertSize(totalSize);
      files.push({ name: basename(path), base64: content.toString("base64") });
    }
    return { selector: body.selector, files };
  }

  async receiveDownload(sessionId: string, value: unknown): Promise<unknown> {
    const result = value as { path?: string; size?: number; base64?: string };
    const downloadDir = this.sessions.get(sessionId)?.downloadDir;
    if (!downloadDir || !result.base64 || !result.path) return value;
    const path = join(downloadDir, portableBasename(result.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(result.base64, "base64"));
    return { path, size: result.size };
  }

  async receiveClose(sessionId: string, value: unknown): Promise<unknown> {
    const paths = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const result = value as { videoPath?: string; videoBase64?: string };
    if (!paths?.videoPath || !result.videoBase64) return value;
    await mkdir(dirname(paths.videoPath), { recursive: true });
    await writeFile(paths.videoPath, Buffer.from(result.videoBase64, "base64"));
    return { ...result, videoPath: paths.videoPath, videoBase64: undefined };
  }

  clear(): void {
    this.sessions.clear();
  }

  private assertSize(size: number): void {
    if (size > MAX_ARTIFACT_BYTES) throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
  }
}

function portableBasename(path: string): string {
  return basename(path.replaceAll("\\", "/"));
}

export class RemoteArtifactHost {
  private readonly directories = new Map<string, string>();

  async prepareSession(
    input: StartSessionInput,
    transfer: boolean,
  ): Promise<{ input: StartSessionInput; directory?: string }> {
    if (!transfer) return { input };
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-remote-"));
    const downloadDir = input.downloadDir ? join(directory, "downloads") : undefined;
    if (downloadDir) await mkdir(downloadDir, { recursive: true });
    return {
      directory,
      input: {
        ...input,
        downloadDir,
        videoPath: input.videoPath ? join(directory, basename(input.videoPath)) : undefined,
      },
    };
  }

  track(sessionId: string, directory?: string): void {
    if (directory) this.directories.set(sessionId, directory);
  }

  async upload(controller: InteractiveController, selector: string, files: TransferredFile[]): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-upload-"));
    try {
      let totalSize = 0;
      const paths: string[] = [];
      for (const file of files) {
        const content = Buffer.from(file.base64, "base64");
        totalSize += content.byteLength;
        if (totalSize > MAX_ARTIFACT_BYTES)
          throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
        const path = join(directory, basename(file.name));
        await writeFile(path, content);
        paths.push(path);
      }
      await controller.elementAction({ action: "upload", selector, paths });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async transferFile(sessionId: string, value: unknown): Promise<unknown> {
    if (!this.directories.has(sessionId)) return value;
    const result = value as { path?: string; size?: number };
    if (!result.path) return value;
    const content = await readFile(result.path);
    if (content.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
    return { ...result, base64: content.toString("base64") };
  }

  async close(
    sessionId: string,
    result: { videoPath?: string },
  ): Promise<{ videoPath?: string; videoBase64?: string }> {
    const directory = this.directories.get(sessionId);
    this.directories.delete(sessionId);
    if (!directory) return result;
    try {
      if (!result.videoPath) return result;
      const content = await readFile(result.videoPath);
      if (content.byteLength > MAX_ARTIFACT_BYTES)
        throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
      return { ...result, videoBase64: content.toString("base64") };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async discard(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }

  async discardSession(sessionId: string): Promise<void> {
    const directory = this.directories.get(sessionId);
    this.directories.delete(sessionId);
    if (directory) await this.discard(directory);
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.directories.keys()].map((sessionId) => this.discardSession(sessionId)));
  }
}
