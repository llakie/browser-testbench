import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingProbe } from "../../src/automation/video-recorder.js";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";

describe("RecordingProbe", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-video-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns immediately verifiable recording metadata", async () => {
    const path = join(directory, "recording.mp4");
    const bytes = Buffer.from("video bytes");
    await writeFile(path, bytes);
    vi.spyOn(CommandRunner, "run").mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        streams: [
          {
            codec_name: "h264",
            width: 1080,
            height: 2400,
            avg_frame_rate: "2997/100",
            r_frame_rate: "30/1",
            time_base: "1/90000",
          },
        ],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.250" },
      }),
    });

    await expect(RecordingProbe.inspect(path)).resolves.toEqual({
      path,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "video/mp4",
      container: "mov",
      codec: "h264",
      width: 1080,
      height: 2400,
      durationMs: 10_250,
      timeBase: "1/90000",
      averageFrameRate: 29.97,
      frameRateMode: "variable",
    });
  });
});
