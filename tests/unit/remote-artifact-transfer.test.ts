import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteArtifactGateway, RemoteArtifactHost } from "../../src/remote/remote-artifact-transfer.js";
import type { InteractiveController } from "../../src/automation/interactive-controller.js";

describe("remote artifact transfer", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("moves uploads to a temporary remote path and removes it after the browser consumes it", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-artifacts-"));
    const localPath = join(directory, "fixture.txt");
    await writeFile(localPath, "from the local client");
    const gateway = new RemoteArtifactGateway();
    const host = new RemoteArtifactHost();
    const upload = await gateway.uploadRequest({ selector: "#file", paths: [localPath] });
    let remotePath = "";
    const controller = {
      elementAction: vi.fn(async (input: { paths: string[] }) => {
        remotePath = input.paths[0]!;
        expect(await readFile(remotePath, "utf8")).toBe("from the local client");
      }),
    } as unknown as InteractiveController;

    await host.upload(controller, upload.body, upload.bodyHash);
    await expect(readFile(remotePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a modified upload before passing paths to the browser", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-artifacts-"));
    const localPath = join(directory, "fixture.txt");
    await writeFile(localPath, "from the local client");
    const upload = await new RemoteArtifactGateway().uploadRequest({ selector: "#file", paths: [localPath] });
    const controller = { elementAction: vi.fn() } as unknown as InteractiveController;

    await expect(new RemoteArtifactHost().upload(controller, upload.body, "invalid-hash")).rejects.toThrow(
      "integrity verification failed",
    );
    expect(controller.elementAction).not.toHaveBeenCalled();
  });

  it("writes downloaded and video data to the local paths requested by the client", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-artifacts-"));
    const gateway = new RemoteArtifactGateway();
    const downloadDir = join(directory, "downloads");
    const videoPath = join(directory, "video", "run.mp4");
    gateway.trackSession("session", { target: "edge", downloadDir, videoPath });

    const download = await gateway.receiveDownload("session", artifactResponse("report.txt", Buffer.from("report")));
    const close = await gateway.receiveClose("session", artifactResponse("run.mp4", Buffer.from("video")));

    expect(await readFile((download as { path: string }).path, "utf8")).toBe("report");
    expect(await readFile(videoPath, "utf8")).toBe("video");
    expect(close).toMatchObject({ videoPath });
  });

  it("removes a partial local artifact when its declared size is wrong", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-artifacts-"));
    const gateway = new RemoteArtifactGateway();
    const downloadDir = join(directory, "downloads");
    gateway.trackSession("session", { target: "edge", downloadDir });
    const response = artifactResponse("report.txt", Buffer.from("report"));
    response.headers.set("content-length", "7");

    await expect(gateway.receiveDownload("session", response)).rejects.toThrow("does not match");
    expect(await readdir(downloadDir)).toEqual([]);
  });

  it("applies the artifact limit to inline screenshot and PDF data", () => {
    const gateway = new RemoteArtifactGateway();
    expect(() => gateway.assertInlineArtifact({ base64: "YQ==" })).not.toThrow();
    expect(() => gateway.assertInlineArtifact({ data: "a".repeat(70 * 1024 * 1024) })).toThrow(
      "Remote artifacts are limited",
    );
  });
});

function artifactResponse(name: string, content: Buffer): Response {
  const body = new Uint8Array(content.byteLength);
  body.set(content);
  return new Response(body, {
    headers: {
      "content-length": String(content.byteLength),
      "content-type": "application/octet-stream",
      "x-browser-testbench-artifact-name": encodeURIComponent(name),
    },
  });
}
