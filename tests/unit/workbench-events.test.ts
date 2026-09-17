import { describe, expect, it, vi } from "vitest";
import { WorkbenchEvents } from "../../src/setup/workbench-events.js";

describe("WorkbenchEvents", () => {
  it("publishes typed events until a subscriber disconnects", () => {
    const events = new WorkbenchEvents();
    const listener = vi.fn();
    const unsubscribe = events.subscribe(listener);
    const event = {
      type: "environment.changed" as const,
      source: "android" as const,
      occurredAt: "2026-09-17T12:00:00.000Z",
    };

    events.publish(event);
    unsubscribe();
    events.publish(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });
});
