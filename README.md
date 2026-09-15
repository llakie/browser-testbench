# Browser Testbench

A portable Node.js test bench for real desktop browsers and mobile browsers in local simulators. It provides three interfaces over one implementation:

- a deterministic `btb` CLI for repeatable suites and CI;
- a local MCP server for direct control from Codex;
- a guided setup UI plus loopback REST/SSE API for people and other local clients.

The project is independent of the application under test. Copy this directory anywhere, run `npm ci`, and point a config file at the target application's URL and start command.

## Project layout

```text
src/
├── artifacts/       artifact storage, catalog, and report formatting
├── automation/      browser sessions, interactive control, and video
├── config/          schemas, configuration, target registry, and domain types
├── infrastructure/ low-level commands, paths, and managed processes
├── orchestration/   suite loading, execution, events, and run state
├── setup/           prerequisite checks, guided setup, and verification state
├── support/         the self-test fixture server
├── transports/      REST/SSE and MCP adapters
└── cli.ts           command-line entry point

tests/
├── fixtures/
├── integration/
└── unit/

templates/
├── artifacts/       Eta templates for generated reports
└── ui/              Eta templates for the guided setup

public/
└── ui/              setup behavior and responsive styles
```

Run `npm run format` to format the repository and `npm run format:check` to verify formatting in CI. Generated output, caches, dependencies, and the imported development policy are excluded through `.prettierignore`.

## Target matrix

| Target                     | macOS    | Windows | Driver                 |
| -------------------------- | -------- | ------- | ---------------------- |
| Installed Google Chrome    | yes      | yes     | WebDriver/ChromeDriver |
| Installed Mozilla Firefox  | yes      | yes     | WebDriver/GeckoDriver  |
| Installed Apple Safari     | yes      | no      | Apple SafariDriver     |
| Installed Microsoft Edge   | optional | yes     | WebDriver/EdgeDriver   |
| Safari in iPhone Simulator | yes      | no      | Appium/XCUITest        |
| Chrome in Android Emulator | yes      | yes     | Appium/UiAutomator2    |

This intentionally uses browser-vendor WebDriver implementations. A Playwright WebKit build is not presented as Safari, and a patched test Firefox build is not presented as the installed Firefox.

## Quick start

Node.js 22 or newer is required.

```bash
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js setup --yes
```

`doctor` is read-only and deliberately does not run `safaridriver --diagnose`, start simulators, or trigger permission dialogs. `setup --yes` installs Appium extensions into this project's `.cache/appium` directory. System-level steps are printed as guided actions.

For Android web sessions, Appium may download a matching ChromeDriver from Google's official storage into `.cache/chromedrivers`. Downloads are enabled only for the scoped UiAutomator2 ChromeDriver feature, and Appium listens on loopback.

Verify a target against the included interactive fixture:

```bash
node dist/cli.js verify chrome --headless
node dist/cli.js verify firefox --headless
node dist/cli.js verify safari
node dist/cli.js verify safari-ios
node dist/cli.js verify chrome-android
```

Safari and simulator verification is visible. Only run those commands when opening the browser/simulator is intended.

During development, `npm run btb -- <command>` can be used without building first.

### Guided setup

From the application repository you want to test, start the portable Testbench with its absolute path:

```bash
node /path/to/browser-testbench/dist/cli.js serve
```

The server opens `/setup` in the default browser and guides you through the detected macOS, Windows, or Linux
environment. It checks prerequisites without launching Safari or a simulator, creates `testbench.config.json` in
the current project, offers an advanced JSON editor, and can save and run the suite directly. The configured
application server is started and stopped as part of each test run.

Use a different fixed JSON path or keep the browser closed when needed:

```bash
node /path/to/browser-testbench/dist/cli.js serve --config config/browser-tests.json --no-open
```

Saving needs no Testbench restart. Every UI-triggered run reloads the JSON file. Automatic setup actions only run
after clicking **Setup ausführen**; password-protected Safari activation and macOS privacy changes remain guided
manual steps.

## One-time macOS setup

1. Install Chrome, Firefox, Xcode, and Android Studio.
2. In Xcode Settings > Components, install an iOS Simulator runtime.
3. In Xcode > Window > Devices and Simulators, create an iPhone simulator matching the configured `deviceName`.
4. Enable Safari automation once with `sudo safaridriver --enable`. This requires your password and can display a macOS prompt; the Testbench never runs it silently.
5. In Android Studio > SDK Manager > SDK Tools, install Android SDK Command-line Tools, Android Emulator, and Platform Tools.
6. In Device Manager, create an AVD from a Google Play system image. A plain AOSP image generally does not contain Chrome.
7. Run `node dist/cli.js setup --yes --targets safari-ios,chrome-android --android-avd Browser_Testbench_API_36`.
8. Run `doctor` again, then explicitly verify Safari and both mobile targets.

The Android system image architecture should match the host: `arm64-v8a` on Apple Silicon and normally `x86_64` on Windows.

## One-time Windows setup

1. Install Node.js 22+, Chrome, Firefox, Edge, and Android Studio.
2. Install Android SDK Command-line Tools, Emulator, and Platform Tools from the SDK Manager.
3. Create a Google Play AVD in Device Manager.
4. Run:

```powershell
npm ci
npm run build
node dist/cli.js setup --yes --targets chrome-android --android-avd Browser_Testbench_API_36
node dist/cli.js doctor --targets chrome,firefox,edge,chrome-android
node dist/cli.js verify chrome --headless
node dist/cli.js verify firefox --headless
node dist/cli.js verify edge --headless
node dist/cli.js verify chrome-android
```

Safari and iOS targets report `skip` rather than pretending to run on Windows.

## Application configuration

The guided UI writes a portable `testbench.config.json`. For hand-authored, platform-conditional configuration,
`testbench.config.mjs` remains supported by the `run` command:

```js
export default {
  name: "my-application",
  baseUrl: "http://127.0.0.1:3000",
  webServer: {
    command: "npm run dev",
    cwd: ".",
    healthUrl: "http://127.0.0.1:3000/health",
    timeoutMs: 60_000,
    env: { NODE_ENV: "test" },
  },
  targets:
    process.platform === "darwin"
      ? [
          { name: "chrome", headless: true },
          { name: "firefox", headless: true },
          "safari",
          { name: "safari-ios", deviceName: "iPhone 16", recordVideo: true },
          { name: "chrome-android", avd: "Browser_Testbench_API_36", recordVideo: true },
        ]
      : [
          { name: "chrome", headless: true },
          { name: "firefox", headless: true },
          { name: "edge", headless: true },
          { name: "chrome-android", avd: "Browser_Testbench_API_36" },
        ],
  specs: ["tests/browser/**/*.spec.mjs"],
  artifactsDir: "artifacts/browser-testbench",
  maxDesktopWorkers: 2,
  failFast: false,
};
```

Relative paths are resolved from the config file, not from the Testbench installation. Android Emulator URLs using `localhost` or `127.0.0.1` are automatically rewritten to the host alias `10.0.2.2`.

An ad-hoc smoke test needs no config:

```bash
node /path/to/browser-testbench/dist/cli.js run \
  --url http://127.0.0.1:3000 \
  --targets chrome,firefox \
  --headless
```

## Test specs

Specs are standard ESM modules. They receive the Testbench's Selenium-backed browser handle and small helpers:

```js
import assert from "node:assert/strict";

export default [
  {
    name: "user can sign in",
    skipTargets: [],
    async run({ browser, step, screenshot, gesture, target }) {
      await step("enter credentials", async () => {
        await browser.$("[name=email]").setValue(process.env.TEST_EMAIL);
        await browser.$("[name=password]").setValue(process.env.TEST_PASSWORD);
      });
      await step("submit", async () => browser.$("button=Sign in").click());
      if (target.name === "safari-ios" || target.name === "chrome-android") {
        await gesture({ type: "swipe", direction: "up", percent: 0.7 });
      }
      await browser.$("h1=Dashboard").waitForDisplayed();
      assert.equal(await browser.$("h1").getText(), "Dashboard");
      await screenshot(`signed-in-${target.name}`);
    },
  },
];
```

Use stable accessibility labels, test IDs, labels, or semantic text. Avoid fragile absolute XPath selectors.

## CLI reference

```text
btb targets [--json]
btb doctor [--targets chrome,firefox] [--json]
btb setup [--targets ...] [--android-avd name] [--yes] [--json]
btb run [--config file] [--url URL] [--targets ...] [--specs ...] [--headless] [--json|--jsonl]
btb verify <target> [--headless]
btb open --target <target> --url <URL>
btb screenshot --target <target> --url <URL> [--output file.png] [--headless]
btb serve [--host 127.0.0.1] [--port 0] [--token secret] [--config file.json] [--no-open]
btb mcp
btb mcp-config
btb report path/to/summary.json [--json]
```

Desktop targets that support parallel execution use `maxDesktopWorkers`. Safari and mobile targets are serialized to avoid driver and device contention. Processes started from `webServer.command` are terminated as a process tree after each run.

## Codex MCP setup

Build first, then print the exact registration command:

```bash
npm run build
node dist/cli.js mcp-config
```

Run the printed `codex mcp add ...` command, then restart Codex. The MCP server exposes:

- `doctor` and `list_targets`;
- `start_session`, `navigate`, `inspect_page`, `click`, `type`, `tap`, `swipe`, `pinch`, `get_page_source`, `take_screenshot`, and `close_session`;
- `run_suite`, `get_run_status`, `list_artifacts`, and `read_artifact`.

The MCP server uses STDIO and does not open a network port. It maintains one interactive session at a time so that state and cleanup remain deterministic. Full suites can still run multiple eligible desktop targets in parallel.

Codex can always fall back to the CLI if the MCP configuration is unavailable in a particular session.

## Local REST/SSE API

Start a loopback server:

```bash
node dist/cli.js serve --port 7788
```

This opens the Eta-rendered setup UI automatically. Pass `--no-open` for headless machines and CI.

Main endpoints:

```text
GET    /health
GET    /v1/targets
GET    /v1/doctor
GET    /v1/workbench
PUT    /v1/workbench/config
POST   /v1/workbench/setup
POST   /v1/workbench/run
POST   /v1/runs
GET    /v1/runs
GET    /v1/runs/:id
GET    /v1/runs/:id/artifacts
GET    /v1/runs/:id/artifact?path=<relative-path>
GET    /v1/events                 Server-Sent Events
POST   /v1/session
GET    /v1/session/inspect
POST   /v1/session/navigate
POST   /v1/session/click
POST   /v1/session/type
POST   /v1/session/screenshot
POST   /v1/session/gesture
DELETE /v1/session
```

Example:

```bash
curl -X POST http://127.0.0.1:7788/v1/runs \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","targets":["chrome","firefox"],"headless":true}'

curl -N http://127.0.0.1:7788/v1/events
```

Binding outside loopback requires `--token`; requests then need `Authorization: Bearer ...`. The API does not accept arbitrary shell commands. A configured `webServer.command` is loaded from a trusted local config file.

The screenshot endpoint returns both the absolute local path and PNG data as base64. Run artifacts are addressed only by paths relative to their run directory; parent-directory traversal is rejected.

Mobile gestures use `POST /v1/session/gesture` with one of these payloads:

```json
{ "type": "tap", "x": 120, "y": 240 }
{ "type": "swipe", "direction": "up", "percent": 0.75 }
{ "type": "pinch", "direction": "out", "percent": 0.5 }
```

`area` and pixel-per-second `speed` optionally tune Android gestures. `velocity` optionally tunes iOS gestures. When no Android area is supplied, the current window rectangle is used. Gestures reject desktop targets instead of emulating mouse input.

## Artifacts and exit behavior

Each run creates:

```text
artifacts/<run-id>/
├── manifest.json
├── summary.json
├── junit.xml
├── report.html
└── <target>/
    ├── requested screenshots
    ├── <test>-failure.png
    └── <test>-failure-source.html
```

`report.html` is rendered from `templates/artifacts/report.eta` with Eta. Report markup and styles can therefore be changed without editing the artifact writer.

For mobile targets, `recordVideo: true` captures `session.mp4` using `simctl` or Android `screenrecord`. It is disabled by default. Successful runs exit with code `0`. Failed assertions, unavailable requested targets, invalid configuration, and infrastructure failures exit non-zero. Targets are never silently substituted—for example, Safari is never replaced with WebKit.

## Security and test data

- The API defaults to loopback and requires a token for non-loopback binding.
- MCP uses local STDIO.
- Browser sessions use isolated automation profiles rather than personal browser data.
- Keep credentials in environment variables; do not put them in configs, specs, screenshots, or committed artifacts.
- The Testbench never enters administrator passwords, accepts SDK licenses, or changes macOS privacy settings silently.

## Verification commands for maintainers

```bash
npm run check
npm test
BTB_BROWSER_TESTS=1 npm test
npm run build
node dist/cli.js verify chrome --headless
node dist/cli.js verify firefox --headless
```

The browser integration flag runs a real MCP-client-to-Chrome flow in addition to unit, config, API, and protocol tests.
