# Browser Testbench

A local, project-independent remote control for real desktop browsers and iOS and Android simulators.

The responsibilities are deliberately clear:

- Browser Testbench detects, launches, and controls browsers and simulated devices.
- Your project starts its own development server and owns its test flows, URLs, assertions, and result files.
- AI assistants access the same controls through MCP.

Browser Testbench does not import test files from a project or run third-party test runners.

## Supported targets

| Target                         | macOS | Windows | Linux |
| ------------------------------ | ----- | ------- | ----- |
| Chrome                         | yes   | yes     | yes   |
| Firefox                        | yes   | yes     | yes   |
| Safari                         | yes   | –       | –     |
| Edge                           | yes   | yes     | yes   |
| Safari in the iOS Simulator    | yes   | –       | –     |
| Chrome in the Android Emulator | yes   | yes     | yes   |

Mobile sessions are controlled through Appium with XCUITest or UiAutomator2. The web interface detects installed browsers, simulators, emulators, and required setup steps.

For Android, setup always reuses an existing compatible Google Play AVD. If none exists, it selects the newest matching Google Play system image already installed for the host architecture and the newest available generic Pixel hardware profile. The generated AVD name contains both values, for example `browser-testbench-pixel-10-api-37-1`. Only when no suitable image is installed does the setup ask you to install the latest one through Android Studio's SDK Manager; no API level or Pixel model is hard-coded.

## Installation and startup

Node.js 22 or newer is required. Install Browser Testbench globally once on each machine:

```bash
npm install --global browser-testbench
browser-testbench start
```

By default, the interface runs at `http://127.0.0.1:55808/setup` and opens on startup. To use a different address:

```bash
browser-testbench start --port 7788 --no-open
```

For development directly from the repository:

```bash
git clone https://github.com/llakie/browser-testbench.git
cd browser-testbench
npm ci
npm run dev -- start
```

The web interface has three sections:

- `/setup`: inspect and set up the environment
- `/targets`: verify test targets and generate project commands
- `/docs`: local documentation and examples

The project license and third-party license notices are included as `LICENSE.txt` and `THIRD_PARTY_LICENSES.txt` and linked from the interface footer.

A bearer token is required when binding to an address other than loopback:

```bash
browser-testbench start --host 0.0.0.0 --token "$BROWSER_TESTBENCH_TOKEN"
```

To avoid unexpected macOS permission dialogs, Safari is never launched automatically. Enable its driver once:

```bash
sudo safaridriver --enable
browser-testbench verify safari
```

`verify` accepts any concrete ID returned by `browser-testbench targets` and runs the check through the active Browser Testbench server. You can trigger the same check explicitly from the web interface with “Run test”.

## Two workflows

### Interactive development and debugging

An AI assistant can use MCP to open a session, navigate, inspect elements, click, type, take screenshots, and perform mobile gestures. The MCP process is a lightweight bridge to the running Browser Testbench server; target resolution, sessions, and device locks remain centralized. Console output and HTTP requests and responses are available through `get_diagnostics`. WebSocket transport and WebSocket frame inspection are not currently included.

`get_devtools_instructions` provides the appropriate connection for native browser developer tools:

- iOS Simulator: Safari Web Inspector through Safari's Develop menu.
- Android Emulator: Chrome DevTools through `chrome://inspect/#devices`.
- Chromium on desktop: console and network diagnostics directly through Browser Testbench; the regular browser developer tools can also be opened manually.

### Automated project tests

Browser Testbench creates a stable ID for every detected browser and compatible simulated device. Examples include `chrome` and `safari-ios-iphone-17-pro-26-5`. The web interface lists every ID with a copy button. No project configuration file is required.

Install the client in your project:

```bash
npm install --save-dev browser-testbench
```

Any Node-based test runner can then use the same remote control:

```js
import assert from "node:assert/strict";
import { RemoteTestbench } from "browser-testbench/client";

const testbench = new RemoteTestbench();
const targets = await testbench.availableTargets(["chrome", "safari-ios-iphone-17-pro-26-5"]);

for (const target of targets) {
  const browser = await testbench.open({
    target,
    url: "http://127.0.0.1:5173/login",
    headless: true,
  });

  try {
    await browser.fill('input[name="email"]', "test@example.com");
    await browser.check('[data-testid="terms"]');
    await browser.click('button[type="submit"]');
    await browser.waitForText("Welcome");
    assert.match((await browser.inspect()).url, /dashboard/);
    await browser.screenshot(`artifacts/login-${target}.png`);
  } finally {
    await browser.close();
  }
}
```

`availableTargets()` preserves the requested order and skips targets that are not ready on the current machine. If none of the requested targets are ready, the promise rejects. Browser Testbench resolves a mobile ID internally to its `deviceName`, platform version, and UDID or AVD. Mobile targets ignore `headless`.

For parallel execution, use `forEachTarget()`. Different devices can run in parallel; access to the same serial target is queued by the server.

## Node client

`RemoteTestbench` connects to `http://127.0.0.1:55808` by default. Set a different address through `BROWSER_TESTBENCH_URL` or the constructor. The client provides:

- `targets()`, `capabilities()`, and `availableTargets([...])`
- `open({ target, url, ... })`
- `forEachTarget(targets, options, callback)`

A `RemoteSession` provides:

- Forms: `fill()`, `append()`, `clear()`, `check()`, `uncheck()`, `select()`, `upload()`, and `submit()`
- State: `state()`, `count()`, `inspect()`, `cookies()`, and `storage()`
- Input: `click()`, `press()`, `focus()`, `blur()`, `hover()`, `doubleClick()`, `rightClick()`, and `drag()`
- Navigation: `navigate()`, `back()`, `forward()`, `refresh()`, tabs/windows, and frames
- Waiting: element, text, URL, value, count, and states such as visible, removed, enabled, or selected
- Browser state: cookies, local/session storage, dialogs, and viewport
- Files: upload, project-side screenshots, and downloads with a configured `downloadDir`
- Debugging: full-page/element screenshots, PDF, accessibility tree, clipboard, and JavaScript evaluation
- Environment: network conditions, blocked URLs, fetch mocks, geolocation, and permissions on Chromium targets
- `tap()`, `swipe()`, and `pinch()` for mobile targets
- Mobile: orientation, Back button, dismissing the keyboard, and optional MP4 recording
- `diagnostics()`, `clearDiagnostics()`, and `devtools()`
- `close()`

All element methods accept standards-compliant CSS selectors only. Prefer stable attributes such as IDs, `name`, or `data-testid` for robust tests, for example `#login`, `input[name="email"]`, or `[data-testid="terms"]`. For open shadow roots, use `evaluate()` with `shadowRoot.querySelector()` when needed.

Screenshots are saved by the client inside the project. For downloads, provide a `downloadDir` on the Browser Testbench machine when opening the session.

`mockFetch()` replaces fetch responses in the currently loaded page. `blockUrls()`, network conditions, geolocation, permissions, PDF, and the native accessibility tree use Chromium DevTools and are therefore intended for Chrome and Edge. WebDriver-based forms, navigation, and state operations remain available on other targets. For mobile videos, set `videoPath` when opening the session; recording is finalized when the session closes.

## MCP

The web interface generates or installs configuration for Codex, Claude Code, Gemini CLI, GitHub Copilot in VS Code, and other MCP clients. The MCP server uses `stdio`:

```bash
browser-testbench mcp
```

Key tools:

- Environment: `list_targets`, `doctor`, `verify_target`
- Session: `start_session`, `navigate`, `inspect_page`, `close_session`
- Interaction: `click`, `type`, `element_action`, `browser_action`, `tap`, `swipe`, `pinch`
- Synchronization: `wait_for_element`, `wait_for_text`, `wait_for_url`, `wait_for_state`, `wait_for_value`, `wait_for_count`
- Debugging: `get_page_source`, `take_screenshot`, `get_diagnostics`, `clear_diagnostics`, `get_devtools_instructions`

## REST API

```text
GET    /health
GET    /v1/targets
GET    /v1/capabilities
POST   /v1/verify
GET    /v1/doctor
GET    /v1/workbench
POST   /v1/workbench/setup
POST   /v1/workbench/mcp
GET    /v1/sessions
POST   /v1/sessions
DELETE /v1/sessions/:id
GET    /v1/sessions/:id/inspect
GET    /v1/sessions/:id/source
POST   /v1/sessions/:id/navigate
POST   /v1/sessions/:id/click
POST   /v1/sessions/:id/type
POST   /v1/sessions/:id/element
POST   /v1/sessions/:id/browser
POST   /v1/sessions/:id/wait
POST   /v1/sessions/:id/gesture
POST   /v1/sessions/:id/screenshot
GET    /v1/sessions/:id/diagnostics
DELETE /v1/sessions/:id/diagnostics
GET    /v1/sessions/:id/devtools
```

Multiple sessions can exist at the same time. Mobile targets typically remain serial because of their drivers and devices. All client calls go through the central REST API.

## Command line

```text
browser-testbench start [--host 127.0.0.1] [--port 55808] [--token ...] [--no-open]
browser-testbench targets [--server URL] [--token ...] [--json]
browser-testbench doctor [--targets ...] [--json]
browser-testbench setup [--targets ...] [--yes] [--json]
browser-testbench verify <target-id> [--headless] [--server URL] [--token ...]
browser-testbench open --target <target> --url <url>
browser-testbench screenshot --target <target> --url <url> [--output file]
browser-testbench mcp
browser-testbench mcp-config --client <client>
```

## Development

```bash
npm run format
npm run check
npm test
BTB_BROWSER_TESTS=1 npm test
npm run build
```

Browser integration tests launch Chrome in headless mode only. Safari and simulators are never opened without an explicit user action as part of automated tests.

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pull request expectations. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release changes are documented in [CHANGELOG.md](CHANGELOG.md).
