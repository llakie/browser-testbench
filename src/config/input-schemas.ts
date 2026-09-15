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
      udid: z.string().min(1).optional(),
      downloadDir: z.string().min(1).optional(),
      recordVideo: z.boolean().optional(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
    }),
  ]);

  static readonly targetList = z.strictObject({
    targets: z.array(this.target).min(1).optional(),
  });

  static readonly config = z.strictObject({
    name: z.string().min(1),
    baseUrl: z.url(),
    targetPolicy: z.enum(["available", "strict"]).optional(),
    targets: z.array(this.targetConfig).min(1),
    specs: z.array(z.string()).optional(),
    artifactsDir: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxDesktopWorkers: z.number().int().positive().optional(),
    failFast: z.boolean().optional(),
  });

  static readonly startSession = z.strictObject({
    target: z.string().min(1),
    url: z.url().optional(),
    headless: z.boolean().optional(),
    downloadDir: z.string().min(1).optional(),
    videoPath: z.string().min(1).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  });

  static readonly setup = z.strictObject({
    targets: z.array(this.target).min(1),
    androidAvdName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
  });

  static readonly mcpIntegration = z.strictObject({
    client: z.enum(["codex", "claude-code", "gemini-cli"]),
  });

  static readonly navigate = z.strictObject({ url: z.url() });
  static readonly click = z.strictObject({ selector: z.string().min(1) });
  static readonly type = z.strictObject({
    selector: z.string().min(1),
    value: z.string(),
    clear: z.boolean().default(true),
  });
  static readonly elementAction = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("state"), selector: z.string().min(1) }),
    z.strictObject({ action: z.literal("count"), selector: z.string().min(1) }),
    z.strictObject({ action: z.literal("fill"), selector: z.string().min(1), value: z.string() }),
    z.strictObject({ action: z.literal("type"), selector: z.string().min(1), value: z.string() }),
    z.strictObject({ action: z.literal("clear"), selector: z.string().min(1) }),
    z.strictObject({
      action: z.enum(["check", "uncheck", "focus", "blur", "submit", "scrollIntoView", "screenshot"]),
      selector: z.string().min(1),
    }),
    z.strictObject({ action: z.enum(["hover", "doubleClick", "rightClick"]), selector: z.string().min(1) }),
    z.strictObject({
      action: z.literal("select"),
      selector: z.string().min(1),
      values: z.array(z.string()).min(1),
      by: z.enum(["value", "text", "index"]).default("value"),
    }),
    z.strictObject({
      action: z.literal("upload"),
      selector: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    z.strictObject({
      action: z.literal("press"),
      selector: z.string().min(1).optional(),
      keys: z.array(z.string().min(1)).min(1),
    }),
    z.strictObject({ action: z.literal("drag"), selector: z.string().min(1), target: z.string().min(1) }),
  ]);
  static readonly browserAction = z.discriminatedUnion("action", [
    z.strictObject({
      action: z.enum([
        "back",
        "forward",
        "refresh",
        "windows",
        "closeWindow",
        "cookies",
        "accessibility",
        "printPdf",
        "mobileBack",
        "hideKeyboard",
      ]),
    }),
    z.strictObject({ action: z.literal("scroll"), x: z.number().default(0), y: z.number().default(0) }),
    z.strictObject({ action: z.literal("newWindow"), type: z.enum(["tab", "window"]).default("tab") }),
    z.strictObject({ action: z.literal("switchWindow"), handle: z.string().min(1) }),
    z.strictObject({ action: z.literal("frame"), selector: z.string().min(1).optional() }),
    z.strictObject({
      action: z.literal("alert"),
      behavior: z.enum(["get", "accept", "dismiss"]),
      text: z.string().optional(),
    }),
    z.strictObject({
      action: z.literal("setCookie"),
      cookie: z.strictObject({
        name: z.string().min(1),
        value: z.string(),
        path: z.string().optional(),
        domain: z.string().optional(),
        secure: z.boolean().optional(),
        httpOnly: z.boolean().optional(),
        sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
        expiry: z.number().positive().optional(),
      }),
    }),
    z.strictObject({ action: z.literal("deleteCookie"), name: z.string().min(1).optional() }),
    z.strictObject({ action: z.literal("storage"), area: z.enum(["local", "session"]) }),
    z.strictObject({
      action: z.literal("setStorage"),
      area: z.enum(["local", "session"]),
      key: z.string(),
      value: z.string(),
    }),
    z.strictObject({
      action: z.literal("deleteStorage"),
      area: z.enum(["local", "session"]),
      key: z.string().optional(),
    }),
    z.strictObject({
      action: z.literal("viewport"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    z.strictObject({
      action: z.literal("waitDownload"),
      filename: z.string().min(1),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      action: z.literal("evaluate"),
      script: z.string().min(1),
      arguments: z.array(z.unknown()).default([]),
    }),
    z.strictObject({
      action: z.literal("network"),
      offline: z.boolean().default(false),
      latencyMs: z.number().nonnegative().default(0),
      downloadBytesPerSecond: z.number().min(-1).default(-1),
      uploadBytesPerSecond: z.number().min(-1).default(-1),
    }),
    z.strictObject({
      action: z.literal("geolocation"),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().nonnegative().default(1),
    }),
    z.strictObject({
      action: z.literal("permission"),
      name: z.string().min(1),
      state: z.enum(["granted", "denied", "prompt"]),
      origin: z.url().optional(),
    }),
    z.strictObject({ action: z.literal("orientation"), orientation: z.enum(["PORTRAIT", "LANDSCAPE"]) }),
    z.strictObject({ action: z.literal("blockUrls"), patterns: z.array(z.string().min(1)) }),
    z.strictObject({ action: z.literal("clipboardWrite"), text: z.string() }),
    z.strictObject({ action: z.literal("clipboardRead") }),
  ]);
  static readonly screenshot = z.strictObject({
    path: z.string().min(1).optional(),
    fullPage: z.boolean().default(false),
  });
  static readonly wait = z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("element"),
      selector: z.string().min(1),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("text"),
      text: z.string().min(1),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("url"),
      value: z.string().min(1),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("state"),
      selector: z.string().min(1),
      state: z.enum(["visible", "hidden", "present", "absent", "enabled", "disabled", "checked", "unchecked"]),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("value"),
      selector: z.string().min(1),
      value: z.string(),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("count"),
      selector: z.string().min(1),
      count: z.number().int().nonnegative(),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("attribute"),
      selector: z.string().min(1),
      name: z.string().min(1),
      value: z.string().optional(),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("elementText"),
      selector: z.string().min(1),
      text: z.string(),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("windowCount"),
      count: z.number().int().positive(),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("networkIdle"),
      quietMs: z.number().positive().default(500),
      timeoutMs: z.number().positive().default(15_000),
    }),
    z.strictObject({
      type: z.literal("script"),
      script: z.string().min(1),
      arguments: z.array(z.unknown()).default([]),
      timeoutMs: z.number().positive().default(15_000),
    }),
  ]);
  static readonly inspect = z.strictObject({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  static readonly pageSource = z.strictObject({
    maxCharacters: z.coerce.number().int().min(1_000).max(500_000).default(100_000),
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
export type GestureInput = z.infer<typeof InputSchemas.gesture>;
export type GestureRequest = z.input<typeof InputSchemas.gesture>;
export type WaitRequest = z.input<typeof InputSchemas.wait>;
export type ElementActionRequest = z.input<typeof InputSchemas.elementAction>;
export type BrowserActionRequest = z.input<typeof InputSchemas.browserAction>;
