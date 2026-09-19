import type { ElementActionRequest, StartSessionInput } from "../config/input-schemas.js";
import type { RemotePrincipal } from "./remote-types.js";

export class RemoteSessionPolicyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
  }
}

export class RemoteSessionPolicy {
  static assertStart(
    input: StartSessionInput,
    transferArtifacts: boolean,
    remote: boolean,
    principal: RemotePrincipal,
  ): void {
    if (!remote || principal.local) return;
    if (input.capabilities && principal.role !== "admin") {
      throw new RemoteSessionPolicyError(
        "Administrative access is required to override browser or device capabilities.",
        403,
      );
    }
    if ((input.downloadDir || input.videoPath) && !transferArtifacts) {
      throw new RemoteSessionPolicyError("Remote file paths must use the artifact transfer protocol.", 400);
    }
  }

  static assertElement(input: ElementActionRequest, remote: boolean, principal: RemotePrincipal): void {
    if (remote && !principal.local && input.action === "upload") {
      throw new RemoteSessionPolicyError("Remote uploads must use the artifact transfer protocol.", 400);
    }
  }
}
