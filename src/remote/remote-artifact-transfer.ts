import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StartSessionInput } from "../config/input-schemas.js";
import type { InteractiveController } from "../automation/interactive-controller.js";

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

interface UploadManifest {
  selector: string;
  files: Array<{ name: string; size: number }>;
}

interface RemoteUpload {
  body: Readable;
  bodyHash: string;
}

export interface RemoteArtifactFile {
  path: string;
  size: number;
  name: string;
  directory?: string;
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

  async uploadRequest(body: { selector: string; paths: string[] }): Promise<RemoteUpload> {
    let totalSize = 0;
    const files: UploadManifest["files"] = [];
    for (const path of body.paths) {
      const file = await stat(path);
      if (!file.isFile()) throw new Error(`Remote upload source '${path}' is not a file.`);
      totalSize += file.size;
      this.assertSize(totalSize);
      files.push({ name: basename(path), size: file.size });
    }
    const header = Buffer.from(JSON.stringify({ selector: body.selector, files } satisfies UploadManifest));
    if (header.byteLength > 65_536) throw new Error("Remote upload metadata is too large.");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(header.byteLength);
    const hash = createHash("sha256").update(prefix).update(header);
    for (const path of body.paths) for await (const chunk of createReadStream(path)) hash.update(chunk);
    return {
      bodyHash: hash.digest("base64url"),
      body: Readable.from(this.uploadChunks(prefix, header, body.paths)),
    };
  }

  async receiveDownload(sessionId: string, response: Response): Promise<{ path: string; size: number }> {
    const downloadDir = this.sessions.get(sessionId)?.downloadDir;
    if (!downloadDir) throw new Error("The local session does not define a download directory.");
    return this.receiveFile(response, join(downloadDir, this.responseFileName(response)));
  }

  async receiveClose(sessionId: string, response: Response): Promise<unknown> {
    const paths = this.sessions.get(sessionId);
    try {
      if (response.headers.get("content-type")?.startsWith("application/octet-stream")) {
        if (!paths?.videoPath) throw new Error("The local session does not define a video path.");
        await this.receiveFile(response, paths.videoPath);
        return { closed: true, videoPath: paths.videoPath };
      }
      return await response.json();
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  clear(): void {
    this.sessions.clear();
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  assertInlineArtifact(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const result = value as { base64?: unknown; data?: unknown };
    const encoded =
      typeof result.base64 === "string" ? result.base64 : typeof result.data === "string" ? result.data : undefined;
    if (!encoded) return;
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    this.assertSize(Math.floor((encoded.length * 3) / 4) - padding);
  }

  private assertSize(size: number): void {
    if (size > MAX_ARTIFACT_BYTES) throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
  }

  private async *uploadChunks(prefix: Buffer, header: Buffer, paths: string[]): AsyncGenerator<Buffer> {
    yield prefix;
    yield header;
    for (const path of paths) for await (const chunk of createReadStream(path)) yield chunk as Buffer;
  }

  private async receiveFile(response: Response, path: string): Promise<{ path: string; size: number }> {
    const declaredSize = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_ARTIFACT_BYTES)
      throw new Error("The remote artifact size is missing or exceeds the configured limit.");
    if (!response.body) throw new Error("The remote artifact response has no body.");
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.browser-testbench-part`;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        callback(
          received <= MAX_ARTIFACT_BYTES ? null : new Error("The remote artifact exceeds its size limit."),
          chunk,
        );
      },
    });
    try {
      await pipeline(
        Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
        limiter,
        createWriteStream(temporaryPath),
      );
      if (received !== declaredSize) throw new Error("The remote artifact size does not match its response headers.");
      await rm(path, { force: true });
      await rename(temporaryPath, path);
      return { path, size: received };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private responseFileName(response: Response): string {
    const encoded = response.headers.get("x-browser-testbench-artifact-name");
    if (!encoded) throw new Error("The remote artifact filename is missing.");
    const name = decodeURIComponent(encoded);
    if (!name || portableBasename(name) !== name) throw new Error("The remote artifact filename is invalid.");
    return name;
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

  async upload(
    controller: InteractiveController,
    source: AsyncIterable<Uint8Array>,
    expectedHash: string,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "browser-testbench-upload-"));
    const bundle = join(directory, "upload.bin");
    try {
      const hash = createHash("sha256");
      let received = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.byteLength;
          if (received > MAX_ARTIFACT_BYTES + 65_540) {
            callback(new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.from(source), verifier, createWriteStream(bundle));
      if (hash.digest("base64url") !== expectedHash) throw new Error("Remote upload integrity verification failed.");
      const manifest = await this.readUploadManifest(bundle, received);
      const paths: string[] = [];
      let offset = 4 + manifest.headerSize;
      for (const [index, file] of manifest.files.entries()) {
        const path = join(directory, String(index), file.name);
        await mkdir(dirname(path), { recursive: true });
        if (file.size > 0)
          await pipeline(
            createReadStream(bundle, { start: offset, end: offset + file.size - 1 }),
            createWriteStream(path),
          );
        else await writeFile(path, "");
        paths.push(path);
        offset += file.size;
      }
      await controller.elementAction({ action: "upload", selector: manifest.selector, paths });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async readUploadManifest(bundle: string, received: number): Promise<UploadManifest & { headerSize: number }> {
    const handle = await open(bundle, "r");
    try {
      const prefix = Buffer.alloc(4);
      if ((await handle.read(prefix, 0, 4, 0)).bytesRead !== 4) throw new Error("Remote upload header is incomplete.");
      const headerSize = prefix.readUInt32BE();
      if (headerSize === 0 || headerSize > 65_536) throw new Error("Remote upload header is invalid.");
      const header = Buffer.alloc(headerSize);
      if ((await handle.read(header, 0, headerSize, 4)).bytesRead !== headerSize)
        throw new Error("Remote upload header is incomplete.");
      const value = JSON.parse(header.toString("utf8")) as Partial<UploadManifest>;
      if (
        typeof value.selector !== "string" ||
        !value.selector ||
        !Array.isArray(value.files) ||
        value.files.length === 0
      )
        throw new Error("Remote upload manifest is invalid.");
      let totalSize = 0;
      const files = value.files.map((file) => {
        if (
          !file ||
          typeof file.name !== "string" ||
          !file.name ||
          portableBasename(file.name) !== file.name ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0
        )
          throw new Error("Remote upload manifest is invalid.");
        totalSize += file.size;
        if (totalSize > MAX_ARTIFACT_BYTES)
          throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
        return { name: file.name, size: file.size };
      });
      if (received !== 4 + headerSize + totalSize) throw new Error("Remote upload size does not match its manifest.");
      return { selector: value.selector, files, headerSize };
    } finally {
      await handle.close();
    }
  }

  async download(sessionId: string, value: unknown): Promise<RemoteArtifactFile | undefined> {
    const directory = this.directories.get(sessionId);
    if (!directory) return undefined;
    const result = value as { path?: string; size?: number };
    if (!result.path) return undefined;
    return this.artifactFile(directory, result.path);
  }

  async completeSession(
    sessionId: string,
    result: { videoPath?: string },
  ): Promise<RemoteArtifactFile | { directory?: string }> {
    const directory = this.directories.get(sessionId);
    this.directories.delete(sessionId);
    if (!directory || !result.videoPath) return { directory };
    try {
      return { ...(await this.artifactFile(directory, result.videoPath)), directory };
    } catch (error) {
      await this.discard(directory);
      throw error;
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

  private async artifactFile(directory: string, path: string): Promise<RemoteArtifactFile> {
    const resolvedDirectory = resolve(directory);
    const resolvedPath = resolve(path);
    const pathFromDirectory = relative(resolvedDirectory, resolvedPath);
    if (pathFromDirectory.startsWith("..") || resolve(resolvedDirectory, pathFromDirectory) !== resolvedPath)
      throw new Error("The remote artifact path is outside its session directory.");
    const file = await stat(resolvedPath);
    if (!file.isFile() || file.size > MAX_ARTIFACT_BYTES)
      throw new Error(`Remote artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes.`);
    return { path: resolvedPath, size: file.size, name: basename(resolvedPath) };
  }
}
