import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ArtifactCatalog } from "../artifacts/artifact-catalog.js";
import { InteractiveController } from "../automation/interactive-controller.js";
import { InputSchemas } from "../config/input-schemas.js";
import { TargetRegistry } from "../config/target-registry.js";
import { runStore } from "../orchestration/run-store.js";
import { DoctorService } from "../setup/doctor-service.js";

export class McpServerHost {
  static async start(): Promise<void> {
    const interactive = new InteractiveController();
    const server = new McpServer(
      { name: "browser-testbench", version: "0.1.0" },
      {
        instructions:
          "Use doctor before starting an unfamiliar target. Use start_session for interactive exploration and run_suite for repeatable tests. Safari authorization is never probed automatically. Close interactive sessions when finished.",
      },
    );
    const target = InputSchemas.target;

    server.registerTool(
      "list_targets",
      {
        description: "List browser and simulator target profiles and their host support.",
        annotations: { readOnlyHint: true },
      },
      async () => textResult(TargetRegistry.definitions),
    );

    server.registerTool(
      "doctor",
      {
        description: "Inspect prerequisites without triggering macOS permission dialogs.",
        inputSchema: InputSchemas.targetList.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ targets }) => textResult(await DoctorService.inspect(targets)),
    );

    server.registerTool(
      "start_session",
      {
        description:
          "Start one interactive real browser or simulator session. Mobile targets require a configured local Appium driver.",
        inputSchema: InputSchemas.startSession.shape,
      },
      async (input) => textResult(await interactive.start(input)),
    );

    server.registerTool(
      "navigate",
      {
        description: "Navigate the active session to a URL and return a compact page inspection.",
        inputSchema: InputSchemas.navigate.shape,
      },
      async ({ url }) => textResult(await interactive.navigate(url)),
    );

    server.registerTool(
      "inspect_page",
      {
        description: "Return the URL, title, and compact list of interactive/semantic elements in the active web page.",
        inputSchema: InputSchemas.inspect.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ limit }) => textResult(await interactive.inspect(limit)),
    );

    server.registerTool(
      "click",
      {
        description: "Click an element in the active session using a CSS, XPath, or tag=text selector.",
        inputSchema: InputSchemas.click.shape,
      },
      async ({ selector }) => {
        await interactive.click(selector);
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
        await interactive.type(selector, value, clear);
        return textResult({ typed: selector });
      },
    );

    server.registerTool(
      "take_screenshot",
      {
        description: "Capture the active browser or device screen and return both the path and image.",
        inputSchema: InputSchemas.screenshot.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ path }) => {
        const screenshot = await interactive.screenshot(path);
        return {
          content: [
            { type: "text" as const, text: screenshot.path },
            { type: "image" as const, data: screenshot.base64, mimeType: "image/png" },
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
      async (input) => textResult(await interactive.gesture({ type: "tap", ...input })),
    );

    server.registerTool(
      "swipe",
      {
        description:
          "Swipe the active mobile screen. Area and speed apply to Android; velocity applies to iOS. Android defaults to the current window area.",
        inputSchema: InputSchemas.swipeGesture.shape,
      },
      async (input) => textResult(await interactive.gesture({ type: "swipe", ...input })),
    );

    server.registerTool(
      "pinch",
      {
        description:
          "Pinch in or out on the active mobile screen. Area and speed apply to Android; velocity applies to iOS.",
        inputSchema: InputSchemas.pinchGesture.shape,
      },
      async (input) => textResult(await interactive.gesture({ type: "pinch", ...input })),
    );

    server.registerTool(
      "get_page_source",
      {
        description: "Return page source from the active session, capped to a requested size.",
        inputSchema: InputSchemas.pageSource.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ maxCharacters }) => ({ content: [{ type: "text", text: await interactive.source(maxCharacters) }] }),
    );

    server.registerTool(
      "close_session",
      {
        description: "Close the active interactive browser/device session and its Appium process.",
      },
      async () => {
        await interactive.close();
        return textResult({ closed: true });
      },
    );

    server.registerTool(
      "run_suite",
      {
        description: "Start a repeatable suite asynchronously. Poll get_run_status with the returned run ID.",
        inputSchema: InputSchemas.run.shape,
      },
      async (input) => textResult(await runStore.start(input)),
    );

    server.registerTool(
      "get_run_status",
      {
        description: "Get the latest state and artifact path for a test run.",
        inputSchema: InputSchemas.runId.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ runId }) => {
        const run = runStore.get(runId);
        return run ? textResult(run) : { content: [{ type: "text", text: `Unknown run '${runId}'.` }], isError: true };
      },
    );

    server.registerTool(
      "list_artifacts",
      {
        description: "List the safely addressable files produced by a test run.",
        inputSchema: InputSchemas.runId.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ runId }) => textResult(await ArtifactCatalog.list(runId)),
    );

    server.registerTool(
      "read_artifact",
      {
        description:
          "Read one artifact from a run. PNG screenshots are returned as images; text artifacts are returned as text.",
        inputSchema: InputSchemas.artifact.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ runId, path }) => {
        const artifact = await ArtifactCatalog.read(runId, path);
        if (artifact.mimeType === "image/png") {
          return {
            content: [{ type: "image" as const, data: artifact.data.toString("base64"), mimeType: "image/png" }],
          };
        }
        if (
          artifact.mimeType.startsWith("text/") ||
          artifact.mimeType.includes("json") ||
          artifact.mimeType.includes("xml")
        ) {
          return { content: [{ type: "text" as const, text: artifact.data.toString("utf8") }] };
        }
        return textResult({
          path: artifact.path,
          size: artifact.size,
          mimeType: artifact.mimeType,
          base64: artifact.data.toString("base64"),
        });
      },
    );

    const shutdown = async () => {
      await interactive.close();
      await server.close();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    await server.connect(new StdioServerTransport());
  }
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
