import { describe, expect, it } from "vitest";
import { InputSchemas } from "../../src/config/input-schemas.js";
import { RemoteSessionPolicy } from "../../src/remote/remote-session-policy.js";
import type { RemotePrincipal } from "../../src/remote/remote-types.js";

const control: RemotePrincipal = { clientId: "control", name: "Control", role: "control", local: false };
const admin: RemotePrincipal = { clientId: "admin", name: "Admin", role: "admin", local: false };
const local: RemotePrincipal = { clientId: "local", name: "Local", role: "admin", local: true };

describe("RemoteSessionPolicy", () => {
  it("keeps host-level capability overrides behind administrative access", () => {
    const input = { target: "chrome", capabilities: { "goog:chromeOptions": { binary: "host-browser" } } };

    expect(() => RemoteSessionPolicy.assertStart(input, false, true, control)).toThrow(
      "Administrative access is required",
    );
    expect(() => RemoteSessionPolicy.assertStart(input, false, true, admin)).not.toThrow();
    expect(() => RemoteSessionPolicy.assertStart(input, false, true, local)).not.toThrow();
  });

  it("requires remote clients to use artifact transfer for host file operations", () => {
    expect(() =>
      RemoteSessionPolicy.assertStart({ target: "chrome", downloadDir: "C:\\host" }, false, true, admin),
    ).toThrow("artifact transfer protocol");
    expect(() =>
      RemoteSessionPolicy.assertStart({ target: "chrome", downloadDir: "client-project" }, true, true, control),
    ).not.toThrow();
    expect(() =>
      RemoteSessionPolicy.assertElement(
        { action: "upload", selector: "input", paths: ["C:\\host\\secret.txt"] },
        true,
        admin,
      ),
    ).toThrow("artifact transfer protocol");
  });

  it("rejects download filenames that escape their configured directory", () => {
    expect(() =>
      InputSchemas.browserAction.parse({ action: "waitDownload", filename: "../secret.txt", timeoutMs: 100 }),
    ).toThrow("Expected a filename without directories");
    expect(() =>
      InputSchemas.browserAction.parse({ action: "waitDownload", filename: "..\\secret.txt", timeoutMs: 100 }),
    ).toThrow("Expected a filename without directories");
  });
});
