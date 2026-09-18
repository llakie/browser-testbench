import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const body = await gateway.uploadBody({ selector: "#file", paths: [localPath] });
    let remotePath = "";
    const controller = {
      elementAction: vi.fn(async (input: { paths: string[] }) => {
        remotePath = input.paths[0]!;
        expect(await readFile(remotePath, "utf8")).toBe("from the local client");
      }),
    } as unknown as InteractiveController;

    await host.upload(controller, body.selector, body.files);
    await expect(readFile(remotePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes downloaded and video data to the local paths requested by the client", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-artifacts-"));
    const gateway = new RemoteArtifactGateway();
    const downloadDir = join(directory, "downloads");
    const videoPath = join(directory, "video", "run.mp4");
    gateway.trackSession("session", { target: "edge", downloadDir, videoPath });

    const download = await gateway.receiveDownload("session", {
      path: "C:\\remote\\report.txt",
      size: 6,
      base64: Buffer.from("report").toString("base64"),
    });
    const close = await gateway.receiveClose("session", {
      videoPath: "C:\\remote\\run.mp4",
      videoBase64: Buffer.from("video").toString("base64"),
    });

    expect(await readFile((download as { path: string }).path, "utf8")).toBe("report");
    expect(await readFile(videoPath, "utf8")).toBe("video");
    expect(close).toMatchObject({ videoPath });
  });
});
