import { z } from "zod";
import { TARGET_NAMES } from "./types.js";

export class InputSchemas {
  static readonly target = z.enum(TARGET_NAMES);

  static readonly targetConfig = z.union([
    this.target,
    z.strictObject({
      name: this.target,
      enabled: z.boolean().optional(),
      headless: z.boolean().optional(),
      deviceName: z.string().min(1).optional(),
      platformVersion: z.string().min(1).optional(),
      avd: z.string().min(1).optional(),
      recordVideo: z.boolean().optional(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
    }),
  ]);

  static readonly targetList = z.strictObject({
    targets: z.array(this.target).min(1).optional(),
  });

  static readonly startSession = z.strictObject({
    target: this.target,
    url: z.url().optional(),
    headless: z.boolean().optional(),
    deviceName: z.string().min(1).optional(),
    platformVersion: z.string().min(1).optional(),
    avd: z.string().min(1).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  });

  static readonly run = z.strictObject({
    configPath: z.string().min(1).optional(),
    url: z.url().optional(),
    targets: z.array(this.target).min(1).optional(),
    specs: z.array(z.string().min(1)).min(1).optional(),
    headless: z.boolean().optional(),
  });

  static readonly setup = z.strictObject({
    targets: z.array(this.target).min(1),
    androidAvdName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
  });

  static readonly navigate = z.strictObject({ url: z.url() });
  static readonly click = z.strictObject({ selector: z.string().min(1) });
  static readonly type = z.strictObject({
    selector: z.string().min(1),
    value: z.string(),
    clear: z.boolean().default(true),
  });
  static readonly screenshot = z.strictObject({ path: z.string().min(1).optional() });
  static readonly inspect = z.strictObject({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  static readonly pageSource = z.strictObject({
    maxCharacters: z.number().int().min(1_000).max(500_000).default(100_000),
  });
  static readonly runId = z.strictObject({ runId: z.string().min(1) });
  static readonly artifact = z.strictObject({
    runId: z.string().min(1),
    path: z.string().min(1),
  });

  static readonly gestureArea = z.strictObject({
    left: z.number().nonnegative(),
    top: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  });

  static readonly tapGesture = z.strictObject({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
  });

  static readonly swipeGesture = z.strictObject({
    direction: z.enum(["up", "down", "left", "right"]),
    percent: z.number().positive().max(0.99).default(0.75),
    area: this.gestureArea.optional(),
    speed: z.number().positive().optional(),
    velocity: z.number().positive().optional(),
  });

  static readonly pinchGesture = z.strictObject({
    direction: z.enum(["in", "out"]),
    percent: z.number().positive().max(0.99).default(0.5),
    area: this.gestureArea.optional(),
    speed: z.number().positive().optional(),
    velocity: z.number().positive().default(1),
  });

  static readonly gesture = z.discriminatedUnion("type", [
    this.tapGesture.extend({ type: z.literal("tap") }),
    this.swipeGesture.extend({ type: z.literal("swipe") }),
    this.pinchGesture.extend({ type: z.literal("pinch") }),
  ]);
}

export type StartSessionInput = z.infer<typeof InputSchemas.startSession>;
export type RunInput = z.infer<typeof InputSchemas.run>;
export type GestureInput = z.infer<typeof InputSchemas.gesture>;
export type GestureRequest = z.input<typeof InputSchemas.gesture>;
