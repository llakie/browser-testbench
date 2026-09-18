import { z } from "zod";
import { TestbenchDefaults } from "./defaults.js";
import { BrowserOrientation, PinchDirection, SwipeDirection } from "./interaction-values.js";
import { TARGET_NAMES } from "./types.js";

export class InputSchemas {
  static readonly target = z.enum(TARGET_NAMES);

  static readonly targetList = z.strictObject({
    targets: z.array(this.target).min(1).optional(),
  });

  static readonly startSession = z.strictObject({
    target: z.string().min(1),
    url: z.url().optional(),
    headless: z.boolean().optional(),
    downloadDir: z.string().min(1).optional(),
    videoPath: z.string().min(1).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    lockTimeoutMs: z.number().nonnegative().optional(),
  });

  static readonly verification = z.strictObject({
    target: z.string().min(1),
    headless: z.boolean().optional(),
  });

  static readonly setup = z.strictObject({
    targets: z.array(this.target).min(1),
  });

  static readonly mcpIntegration = z.strictObject({
    client: z.enum(["codex", "claude-code", "gemini-cli"]),
  });

  static readonly remoteRole = z.enum(["control", "admin"]);
  static readonly remoteInstance = z.strictObject({
    instanceId: z.string().min(1),
    name: z.string().min(1),
    url: z.url(),
    platform: z.enum([
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
      "netbsd",
    ]),
    architecture: z.string().min(1),
    version: z.string().min(1),
    apiVersion: z.number().int().positive(),
  });
  static readonly remoteConnect = z.strictObject({
    instance: this.remoteInstance,
    role: this.remoteRole.default("control"),
  });
  static readonly remotePairingBegin = z.strictObject({
    clientName: z.string().trim().min(1).max(100),
    role: this.remoteRole.default("control"),
  });
  static readonly remotePairingComplete = z.strictObject({
    pairingId: z.uuid(),
    clientId: z.uuid(),
    clientName: z.string().trim().min(1).max(100),
    role: this.remoteRole,
    clientPublicKey: z.string().min(1),
    proof: z.string().min(1),
  });
  static readonly localPairingComplete = z.strictObject({
    pairingId: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
  });
  static readonly remoteClientRole = z.strictObject({ role: this.remoteRole });

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
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
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
    z.strictObject({ action: z.literal("orientation"), orientation: z.enum(BrowserOrientation) }),
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
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("text"),
      text: z.string().min(1),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("url"),
      value: z.string().min(1),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("state"),
      selector: z.string().min(1),
      state: z.enum(["visible", "hidden", "present", "absent", "enabled", "disabled", "checked", "unchecked"]),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("value"),
      selector: z.string().min(1),
      value: z.string(),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("count"),
      selector: z.string().min(1),
      count: z.number().int().nonnegative(),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("attribute"),
      selector: z.string().min(1),
      name: z.string().min(1),
      value: z.string().optional(),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("elementText"),
      selector: z.string().min(1),
      text: z.string(),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("windowCount"),
      count: z.number().int().positive(),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("networkIdle"),
      quietMs: z.number().positive().default(TestbenchDefaults.NETWORK_IDLE_QUIET_MS),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
    z.strictObject({
      type: z.literal("script"),
      script: z.string().min(1),
      arguments: z.array(z.unknown()).default([]),
      timeoutMs: z.number().positive().default(TestbenchDefaults.WAIT_TIMEOUT_MS),
    }),
  ]);
  static readonly inspect = z.strictObject({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TestbenchDefaults.INSPECTION_MAX)
      .default(TestbenchDefaults.INSPECTION_LIMIT),
  });
  static readonly pageSource = z.strictObject({
    maxCharacters: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(TestbenchDefaults.PAGE_SOURCE_MAX)
      .default(TestbenchDefaults.PAGE_SOURCE_LIMIT),
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
    direction: z.enum(SwipeDirection),
    percent: z.number().positive().max(TestbenchDefaults.GESTURE_MAX_PERCENT).default(TestbenchDefaults.SWIPE_PERCENT),
    area: this.gestureArea.optional(),
    speed: z.number().positive().optional(),
    velocity: z.number().positive().optional(),
  });

  static readonly pinchGesture = z.strictObject({
    direction: z.enum(PinchDirection),
    percent: z.number().positive().max(TestbenchDefaults.GESTURE_MAX_PERCENT).default(TestbenchDefaults.PINCH_PERCENT),
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
