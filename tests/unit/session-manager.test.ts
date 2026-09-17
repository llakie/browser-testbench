import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/automation/session-manager.js";

describe("SessionManager", () => {
  it.each([
    new Error("invalid session id"),
    new Error("The session is either terminated or not started"),
    Object.assign(new Error("driver stopped"), { name: "NoSuchSessionError" }),
  ])("recognizes terminated WebDriver sessions", (error) => {
    expect(SessionManager.isTerminatedSessionError(error)).toBe(true);
  });

  it("does not discard sessions for ordinary command failures", () => {
    expect(SessionManager.isTerminatedSessionError(new Error("element not interactable"))).toBe(false);
  });
});
