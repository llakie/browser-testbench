import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PackageMetadata } from "../config/package-metadata.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InputSchemas } from "../config/input-schemas.js";
import { z } from "zod";
import type { RemoteInstance } from "../remote/remote-types.js";
import { RemoteSession, RemoteTestbench, type RemoteTestbenchOptions } from "./testbench-client.js";
import { McpSessionCoordinator } from "./mcp-session-coordinator.js";

export class McpServerHost {
  static async start(options: RemoteTestbenchOptions = {}): Promise<void> {
    const testbench = new RemoteTestbench(options);
    const sessions = new McpSessionCoordinator();
    const active = (): RemoteSession => sessions.active();
    const closeSession = (): Promise<{ videoPath?: string }> => sessions.close();
    const server = new McpServer(
      { name: PackageMetadata.NAME, version: PackageMetadata.VERSION },
      {
        instructions:
          "Use list_targets to obtain concrete browser and device IDs before starting a session. Use the session tools as a remote control for exploration and debugging. Project-owned tests use the same remote controls through the Node client. Safari authorization is never probed automatically. Close sessions when finished.",
      },
    );
    server.registerTool(
      "discover_testbenches",
      {
        description: "Find remotely enabled Browser Testbench instances on the local network.",
        annotations: { readOnlyHint: true },
      },
      async () => textResult(await testbench.discoverTestbenches()),
    );

    server.registerTool(
      "get_testbench_connection",
      {
        description: "Show whether Browser Testbench currently uses local or remote targets.",
        annotations: { readOnlyHint: true },
      },
      async () => textResult(await testbench.connection()),
    );

    server.registerTool(
      "connect_testbench",
      {
        description:
          "Connect to a remote Testbench. Use name or instanceId after discovery, or server for a manual URL. If pairing is required, ask the user for the six-digit code shown by the remote Testbench, then call this tool again with pairingId and code. Request role=admin only when the user explicitly asks for administrative access.",
        inputSchema: {
          nameOrId: z.string().min(1).optional(),
          server: z.url().optional(),
          role: InputSchemas.remoteRole.default("control"),
          pairingId: z.uuid().optional(),
          code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        },
        annotations: { readOnlyHint: false },
      },
      async ({ nameOrId, server: remoteServer, role, pairingId, code }) => {
        if (pairingId || code) {
          if (!pairingId || !code) throw new Error("Both pairingId and code are required to complete pairing.");
          return textResult(await sessions.transition(() => testbench.completePairing(pairingId, code)));
        }
        const instance = remoteServer
          ? await testbench.remoteIdentity(remoteServer)
          : selectRemoteInstance(await testbench.discoverTestbenches(), nameOrId);
        return textResult(await sessions.transition(() => testbench.connectTestbench(instance, role)));
      },
    );

    server.registerTool(
      "disconnect_testbench",
      {
        description: "Close this client's remote sessions and return Browser Testbench to local mode.",
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async () => {
        return textResult(await sessions.transition(() => testbench.disconnectTestbench(), { ignoreCloseError: true }));
      },
    );

    server.registerTool(
      "list_targets",
      {
        description: "List concrete browser and simulator target IDs and their current readiness.",
        annotations: { readOnlyHint: true },
      },
      async () => textResult(await testbench.targets()),
    );

    server.registerTool(
      "doctor",
      {
        description: "Inspect prerequisites without triggering macOS permission dialogs.",
        inputSchema: InputSchemas.targetList.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ targets }) => {
        const checks = (await testbench.capabilities()).checks;
        const requested = targets ? new Set<string>(targets) : undefined;
        return textResult(requested ? checks.filter((check) => requested.has(check.id)) : checks);
      },
    );

    server.registerTool(
      "verify_target",
      {
        description:
          "Run the built-in remote-control smoke test against one concrete ready target and close it afterward.",
        inputSchema: InputSchemas.verification.shape,
      },
      async (input) => textResult(await testbench.verify(input.target, { headless: input.headless })),
    );

    server.registerTool(
      "start_session",
      {
        description: "Start one interactive browser or simulator session using a concrete ID returned by list_targets.",
        inputSchema: InputSchemas.startSession.shape,
      },
      async (input) => {
        const currentSession = await sessions.replace(() => testbench.open(input));
        return textResult({
          id: currentSession.id,
          target: currentSession.target,
          runtime: currentSession.runtime,
        });
      },
    );

    server.registerTool(
      "list_sessions",
      {
        description: "List active sessions owned by this Browser Testbench client, including recoverable sessions.",
        annotations: { readOnlyHint: true },
      },
      async () =>
        textResult(
          (await testbench.sessions()).map((session) => ({
            id: session.id,
            target: session.target,
            runtime: session.runtime,
          })),
        ),
    );

    server.registerTool(
      "navigate",
      {
        description: "Navigate the active session to a URL and return a compact page inspection.",
        inputSchema: InputSchemas.navigate.shape,
      },
      async ({ url }) => textResult(await active().navigate(url)),
    );

    server.registerTool(
      "inspect_page",
      {
        description: "Return the URL, title, and compact list of interactive/semantic elements in the active web page.",
        inputSchema: InputSchemas.inspect.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ limit }) => textResult(await active().inspect(limit)),
    );

    server.registerTool(
      "click",
      {
        description: "Click an element in the active session using a CSS selector.",
        inputSchema: InputSchemas.click.shape,
      },
      async ({ selector }) => {
        await active().click(selector);
        return textResult({ clicked: selector });
      },
    );

    server.registerTool(
      "type",
      {
        description: "Type text into an element in the active session.",
        inputSchema: InputSchemas.type.shape,
      },
      async ({ selector, value, clear }) => {
        await active().type(selector, value, clear);
        return textResult({ typed: selector });
      },
    );

    server.registerTool(
      "element_action",
      {
        description:
          "Perform a form or element action: inspect state/count, fill, append text, clear, check, uncheck, select, upload, focus, blur, submit, press keys, hover, double/right click, drag, scroll into view, or capture an element screenshot. All selectors are standard CSS selectors.",
        inputSchema: InputSchemas.elementAction,
      },
      async (input) => textResult(await active().elementAction(input)),
    );

    server.registerTool(
      "browser_action",
      {
        description:
          "Control browser navigation, scrolling, tabs/windows, frames, JavaScript dialogs, cookies, web storage, or viewport size.",
        inputSchema: InputSchemas.browserAction,
      },
      async (input) => textResult(await active().browserAction(input)),
    );

    server.registerTool(
      "take_screenshot",
      {
        description: "Capture the active browser or device screen and return both the path and image.",
        inputSchema: InputSchemas.screenshot.shape,
        annotations: { readOnlyHint: false },
      },
      async ({ path, fullPage }) => {
        const screenshotPath = path ? resolve(path) : resolve("artifacts", `interactive-${Date.now()}.png`);
        const base64 = await active().screenshotBase64(fullPage);
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, Buffer.from(base64, "base64"));
        return {
          content: [
            { type: "text" as const, text: screenshotPath },
            { type: "image" as const, data: base64, mimeType: "image/png" },
          ],
        };
      },
    );

    server.registerTool(
      "tap",
      {
        description: "Tap absolute screen coordinates in the active iOS or Android simulator session.",
        inputSchema: InputSchemas.tapGesture.shape,
      },
      async (input) => textResult(await active().tap(input.x, input.y)),
    );

    server.registerTool(
      "swipe",
      {
        description:
          "Swipe the active mobile screen. Area and speed apply to Android; velocity applies to iOS. Android defaults to the current window area.",
        inputSchema: InputSchemas.swipeGesture.shape,
      },
      async (input) => textResult(await active().swipe(input)),
    );

    server.registerTool(
      "pinch",
      {
        description:
          "Pinch in or out on the active mobile screen. Area and speed apply to Android; velocity applies to iOS.",
        inputSchema: InputSchemas.pinchGesture.shape,
      },
      async (input) => textResult(await active().pinch(input)),
    );

    server.registerTool(
      "get_page_source",
      {
        description: "Return page source from the active session, capped to a requested size.",
        inputSchema: InputSchemas.pageSource.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ maxCharacters }) => ({ content: [{ type: "text", text: await active().source(maxCharacters) }] }),
    );

    server.registerTool(
      "wait_for_element",
      {
        description: "Wait until an element is present and visible in the active session.",
        inputSchema: InputSchemas.wait.options[0].shape,
        annotations: { readOnlyHint: true },
      },
      async ({ selector, timeoutMs }) => {
        await active().wait({ type: "element", selector, timeoutMs });
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "wait_condition",
      {
        description:
          "Wait for an element, text, URL, element state, value, count, attribute, or text inside a specific element.",
        inputSchema: InputSchemas.wait,
        annotations: { readOnlyHint: false },
      },
      async (input) => {
        await active().wait(input);
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "wait_for_text",
      {
        description: "Wait until text appears in the active page.",
        inputSchema: InputSchemas.wait.options[1].shape,
        annotations: { readOnlyHint: true },
      },
      async ({ text, timeoutMs }) => {
        await active().wait({ type: "text", text, timeoutMs });
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "wait_for_url",
      {
        description: "Wait until the active URL contains a value.",
        inputSchema: InputSchemas.wait.options[2].shape,
        annotations: { readOnlyHint: true },
      },
      async ({ value, timeoutMs }) => {
        await active().wait({ type: "url", value, timeoutMs });
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "wait_for_state",
      {
        description:
          "Wait for an element to become visible, hidden, present, absent, enabled, disabled, checked, or unchecked.",
        inputSchema: InputSchemas.wait.options[3].shape,
        annotations: { readOnlyHint: true },
      },
      async ({ selector, state, timeoutMs }) => {
        await active().wait({ type: "state", selector, state, timeoutMs });
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "wait_for_value",
      {
        description: "Wait until a form control has an exact value.",
        inputSchema: InputSchemas.wait.options[4].shape,
        annotations: { readOnlyHint: true },
      },
      async ({ selector, value, timeoutMs }) => {
        await active().wait({ type: "value", selector, value, timeoutMs });
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "wait_for_count",
      {
        description: "Wait until a selector matches an exact number of elements.",
        inputSchema: InputSchemas.wait.options[5].shape,
        annotations: { readOnlyHint: true },
      },
      async ({ selector, count, timeoutMs }) => {
        await active().wait({ type: "count", selector, count, timeoutMs });
        return textResult({ ready: true });
      },
    );

    server.registerTool(
      "get_diagnostics",
      {
        description:
          "Return captured console output, HTTP request/response, and WebSocket connection/frame diagnostics for the active session.",
        annotations: { readOnlyHint: true },
      },
      async () => textResult(await active().diagnostics()),
    );

    server.registerTool(
      "clear_diagnostics",
      { description: "Clear collected console, HTTP, and WebSocket diagnostics for the active session." },
      async () => {
        await active().clearDiagnostics();
        return textResult({ cleared: true });
      },
    );

    server.registerTool(
      "get_devtools_instructions",
      {
        description: "Explain how to open the native developer tools for the active browser or simulator.",
        annotations: { readOnlyHint: true },
      },
      async () => textResult(await active().devtools()),
    );

    server.registerTool(
      "close_session",
      {
        description:
          "Close the current interactive session, or close a recoverable session by ID after using list_sessions.",
        inputSchema: { id: z.uuid().optional() },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ id }) => {
        const result = !id || sessions.activeId() === id ? await closeSession() : await testbench.closeSession(id);
        return textResult({ closed: true, ...result });
      },
    );

    const shutdown = async () => {
      try {
        await closeSession();
      } finally {
        await server.close();
      }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    await server.connect(new StdioServerTransport());
  }
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function selectRemoteInstance(instances: RemoteInstance[], selector?: string): RemoteInstance {
  if (!selector) {
    if (instances.length === 1) return instances[0]!;
    if (instances.length === 0) throw new Error("No remote Testbench was found. Provide server as a fallback.");
    throw new Error("Multiple remote Testbenches were found. Provide nameOrId.");
  }
  const normalized = selector.toLocaleLowerCase();
  const matches = instances.filter(
    (instance) => instance.instanceId === selector || instance.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length ? `Remote Testbench '${selector}' is ambiguous.` : `Remote Testbench '${selector}' was not found.`,
    );
  return matches[0]!;
}
