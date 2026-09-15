import { InputSchemas, type GestureInput, type GestureRequest } from "../config/input-schemas.js";
import type { TargetConfig } from "../config/types.js";
import type { BrowserHandle } from "./browser-session.js";

interface GestureArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GestureExecution {
  target: TargetConfig["name"];
  command: string;
  parameters: Record<string, unknown>;
}

export class MobileGestures {
  static async perform(
    browser: BrowserHandle,
    target: TargetConfig,
    request: GestureRequest,
  ): Promise<GestureExecution> {
    if (target.name !== "safari-ios" && target.name !== "chrome-android") {
      throw new Error(`Touch gestures require a mobile target; '${target.name}' is a desktop target.`);
    }
    const input = InputSchemas.gesture.parse(request);
    const area =
      target.name === "chrome-android" && input.type !== "tap"
        ? (input.area ?? (await this.viewport(browser)))
        : undefined;
    const execution = this.commandFor(target.name, input, area);
    await browser.execute(execution.command, execution.parameters);
    return execution;
  }

  static commandFor(
    target: "safari-ios" | "chrome-android",
    input: GestureInput,
    area?: GestureArea,
  ): GestureExecution {
    if (input.type === "tap") {
      return {
        target,
        command: target === "safari-ios" ? "mobile: tap" : "mobile: clickGesture",
        parameters: { x: input.x, y: input.y },
      };
    }
    if (input.type === "swipe") {
      if (target === "safari-ios") {
        return {
          target,
          command: "mobile: swipe",
          parameters: { direction: input.direction, ...(input.velocity ? { velocity: input.velocity } : {}) },
        };
      }
      return {
        target,
        command: "mobile: swipeGesture",
        parameters: {
          ...this.requireArea(area),
          direction: input.direction,
          percent: input.percent,
          ...(input.speed ? { speed: input.speed } : {}),
        },
      };
    }
    if (target === "safari-ios") {
      return {
        target,
        command: "mobile: pinch",
        parameters: {
          scale: input.direction === "out" ? 1 + input.percent : 1 - input.percent,
          velocity: input.velocity,
        },
      };
    }
    return {
      target,
      command: input.direction === "out" ? "mobile: pinchOpenGesture" : "mobile: pinchCloseGesture",
      parameters: {
        ...this.requireArea(area),
        percent: input.percent,
        ...(input.speed ? { speed: input.speed } : {}),
      },
    };
  }

  private static async viewport(browser: BrowserHandle): Promise<GestureArea> {
    const rectangle = await browser.getWindowRect();
    return {
      left: Math.max(0, rectangle.x),
      top: Math.max(0, rectangle.y),
      width: rectangle.width,
      height: rectangle.height,
    };
  }

  private static requireArea(area?: GestureArea): GestureArea {
    if (!area) throw new Error("Android swipe and pinch gestures require a screen area.");
    return area;
  }
}
