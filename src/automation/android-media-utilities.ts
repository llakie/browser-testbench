import { readFile } from "node:fs/promises";
import type { AssetReference } from "./session-asset-manager.js";
import type { TestTarget } from "../config/types.js";
import { TestbenchError } from "../errors/testbench-error.js";

export interface CameraImageResource {
  reference: AssetReference;
  path: string;
}

export interface CameraImageMetadata {
  facing: "back";
  source: AssetReference;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
}

export class AndroidMediaUtilities {
  static async prepare(
    target: TestTarget,
    resource: CameraImageResource,
    capabilities: Record<string, unknown> = {},
  ): Promise<{ capabilities: Record<string, unknown>; metadata: CameraImageMetadata }> {
    if (target.browser !== "chrome-android" || target.deviceKind !== "emulator") {
      throw new TestbenchError("MEDIA_INJECTION_UNSUPPORTED", "Static camera images require an Android emulator.", {
        operation: "media.camera.prepare",
        status: 409,
        details: { target: target.id, deviceKind: target.deviceKind },
      });
    }
    if (!new Set(["image/jpeg", "image/png"]).has(resource.reference.contentType)) {
      throw new TestbenchError("MEDIA_INJECTION_UNSUPPORTED", "Camera image must be JPEG or PNG.", {
        operation: "media.camera.prepare",
        status: 415,
        details: { contentType: resource.reference.contentType },
      });
    }
    const { width, height } = this.dimensions(await readFile(resource.path), resource.reference.contentType);
    const existing = capabilities["appium:avdArgs"];
    const avdArgs = Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : [];
    return {
      capabilities: {
        ...capabilities,
        "appium:avdArgs": [...avdArgs, "-camera-back", `imagefile:${resource.path}`],
      },
      metadata: {
        facing: "back",
        source: resource.reference,
        width,
        height,
        orientation: width === height ? "square" : width > height ? "landscape" : "portrait",
      },
    };
  }

  private static dimensions(bytes: Buffer, contentType: string): { width: number; height: number } {
    if (contentType === "image/png" && bytes.subarray(1, 4).toString("ascii") === "PNG") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (contentType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        const length = bytes.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    throw new TestbenchError("MEDIA_INJECTION_UNSUPPORTED", "Camera image dimensions could not be read.", {
      operation: "media.camera.prepare",
      status: 415,
      details: { contentType },
    });
  }
}
