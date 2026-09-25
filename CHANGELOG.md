# Changelog

All notable changes to Browser Testbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-25

### Added

- Session-scoped streaming assets, declarative Android camera images and browser permissions, target capability checks,
  structured screenshots, explicit recording start/stop, recording marks, geometry metadata, and diagnostic bundles.
- Abort signals and options-object timeouts for waits and navigation while retaining positional wait timeouts.
- Structured `TestbenchError` responses with stable error codes and serializable details.

### Changed

- Android loopback URLs use session-owned `adb reverse` mappings by default and remain on `localhost` or `127.0.0.1`.
  The previous `10.0.2.2` behavior is available through `localOrigins: "emulator-host"`.
- Sessions use renewable leases, serial targets use process-aware persistent locks, and failed cleanup quarantines a target
  until cleanup succeeds.
- Mobile recordings stop before browser teardown and can be exported at the exact browser viewport with constant frame
  timing.
- JSON requests are limited to 1 MiB. Larger binary inputs use the streaming asset API.

### Fixed

- Selector actions resolve elements immediately before use and retry once for stale-element driver failures.
- Android permissions, AVD runtime serials, emulator camera asset paths, screenshots, viewport geometry, and short static
  recordings now work through the public API used by Binderium.
- Recording artifacts are finalized and transferred atomically with size and SHA-256 verification.

### Migration

- No intentional source-level breaking changes were introduced. Existing `videoPath`, positional waits, screenshot APIs,
  and `appium:autoGrantPermissions` calls remain supported.
- See [Migrating from Browser Testbench 0.4.x](docs/releases/0.5.0-migration.md) for observable behavior changes and the
  upgrade checklist.

## [0.4.0] - 2026-09-23

### Added

- The Targets page can start, list, and close browser or device debug sessions directly, while retaining the generated
  CLI command as an alternative.
- Local Chromium debug sessions expose a direct link to their hosted DevTools frontend.
- Node and MCP clients can list active sessions and close recoverable sessions by ID after reconnecting.

### Changed

- Client waits and download operations honor their requested operation timeout in addition to transport overhead.
- Remote-control documentation now covers the complete REST surface, proxy host configuration, and the trust boundary
  of unencrypted HTTP transports.
- Responsive target cards and debug controls use the available width more consistently across desktop and mobile
  layouts.

### Fixed

- Aborted or partially started sessions clean up browser processes, device locks, Appium processes, and transferred
  artifacts deterministically, while preserving cleanup failures and aggregate error causes.
- Target verification rejects unavailable targets and reports cleanup errors instead of returning a misleading success.
- Loopback services reject foreign host headers, while explicit wildcard bindings continue to accept valid remote host
  names.
- Remote pairing limits pending requests per address, diagnostic error bodies are bounded, and MCP safety annotations
  correctly describe mutating operations.
- Debug-session controls remain stable after partial navigation failures, and hosted Chrome DevTools can connect to the
  selected local browser session.

## [0.3.1] - 2026-09-23

### Changed

- Setup, device, signing, MCP, target, and API status messages use shared translation descriptors so the web interface
  and CLI present consistent English and German guidance without duplicated compatibility fields.
- Unit tests and browser integration tests run separately, with integration files serialized to prevent resource
  contention and intermittent timeouts on Windows CI runners.

### Fixed

- Appium driver inspection and installation failures preserve the original command diagnostics instead of appearing as
  missing drivers or empty setup failures.
- Automatic setup results distinguish failed, incomplete, and completed outcomes and include the affected step details
  in the web interface.
- Local development discovery handles Windows command shims and Android AVD configuration files with BOMs, comments,
  sections, and platform-specific line endings.

## [0.3.0] - 2026-09-21

### Added

- Physical iPhones and iPads connected by USB are detected and exposed as Safari targets alongside iOS Simulators.
- Older physical iPhones that Xcode exposes through `xcdevice` but not CoreDevice are detected through a bounded
  compatibility fallback.
- Compact guided checklists cover physical iOS and Android setup while keeping detailed troubleshooting available in
  focused accordion sections.
- Physical-iOS guidance covers device trust, Developer Mode, Safari automation settings, WebDriverAgent signing, free
  Personal Teams, paid Developer teams, multi-team selection, and seven-day free-profile renewal failures.
- Physical iOS connection changes now update open web interfaces automatically.
- The web interface and embedded documentation are available in English and German, selected from the browser language
  with English as the default and fallback.

### Changed

- Physical iOS sessions receive deterministic signing capabilities and reject unreachable loopback application URLs
  before starting, while internal verification uses the host's LAN address.
- Simulator-only cleanup is no longer applied to physical Apple devices.
- Project clients, local gateways, and remote Testbenches must use the exact same Browser Testbench version so protocol
  incompatibilities fail early with actionable guidance.

### Fixed

- WebDriverAgent startup failures now distinguish signing, device trust, expired free profiles, proxy failures, and
  Xcode/iOS runner incompatibilities and provide targeted recovery steps.
- Failed or closed physical iOS sessions clean up their automation processes deterministically instead of leaving the
  device in an active automation state.

## [0.2.0] - 2026-09-19

### Added

- Chromium diagnostics now include WebSocket connection lifecycle, handshake, error, and sent/received frame events.
- Remote Testbench hosts can now be discovered through mDNS, paired with control or admin credentials, and used transparently through the existing UI, CLI, Node client, REST gateway, and MCP server.
- Remote sessions support per-client ownership, FIFO serial-target locks, bounded cleanup leases, and project-side artifact transfer.
- The web interface now uses Vue and TypeScript with shared API contracts, reactive state, and live remote-client status updates over the existing event stream.

### Changed

- The shared Testbench UI now exposes explicit remote connect and disconnect controls, keeps remote status visible, and disables administrative controls for non-admin pairings.
- CLI, MCP, and Node client operations use the active local or remote gateway consistently and apply bounded request and setup timeouts.
- Remote setup documentation is platform-neutral and includes diagrams for local and remote operation.
- Remote target guidance distinguishes the remote operating system and suggests the local gateway's LAN address for applications that remote browsers cannot reach through localhost.

### Fixed

- Third-party license generation now honors explicit license replacements and no longer warns about known dual-license packages.
- Remote authentication, artifact transfer, session ownership, process cleanup, and MCP lifecycle transitions are hardened against invalid or interrupted requests.
- Remote control clients no longer receive host-specific browser installation paths or set unrestricted host capabilities.
- Cold Android emulators receive sufficient launch and boot time, including when verification runs through a remote gateway.
- An unavailable Remote Testbench can be disconnected directly from the recovery banner without leaving a stale connection error behind.

## [0.1.8] - 2026-09-18

### Fixed

- Android AVD compatibility detection now considers every `tag.id` and `tag.ids` entry when both formats are present.

## [0.1.7] - 2026-09-18

### Fixed

- Chrome-compatible Android API 36 AVDs using the newer comma-separated `tag.ids` format are detected correctly.

## [0.1.6] - 2026-09-17

### Added

- Physical Android devices connected over USB are detected through ADB and exposed as individual Chrome test targets.
- Localhost URLs are forwarded automatically to physical Android devices for the lifetime of a test session.
- Authenticated server-sent events keep the web interface synchronized when connected Android devices change.

### Changed

- Android setup and status views distinguish physical devices from emulators and provide actionable authorization, offline, and Chrome availability guidance.
- A connected compatible Android device now satisfies Android setup without requiring or provisioning an emulator.
- Background environment refreshes preserve expanded device details and do not interrupt active UI operations.
- Android sessions use installation-safe ADB and UiAutomator2 timeouts.
- Invalid WebDriver sessions are removed automatically so they no longer keep a physical device locked.

### Fixed

- Page inspection and navigation no longer fail in Android Chrome because of build-tool helper code leaking into browser-executed scripts.
- Android full-page screenshot requests now fail clearly instead of returning incomplete or duplicated stitched images.

## [0.1.5] - 2026-09-17

### Added

- Development live reload refreshes open UI pages when templates, styles, or browser scripts change.
- Setup actions can install individual automatic components and show visible progress while work is running.

### Changed

- The environment setup panel now uses full-width action rows, aligned statuses, clearer labels, and truncated path details with full hover text.
- Node.js 22.12 LTS or Node.js 24 and newer is now required to match Appium and other runtime dependencies.

### Fixed

- Windows command scripts such as `code.cmd` and Android SDK batch tools now run through the Windows command shell instead of failing with `spawn EINVAL`.
- Appium installation is no longer offered on Node.js versions that cannot run the bundled Appium dependencies.
- Long-running UI actions consistently display an animated progress indicator instead of only disabling their controls.
- Third-party license generation now includes every supported platform package from the lockfile and produces the same output on macOS, Windows, and Linux.

## [0.1.4] - 2026-09-16

### Fixed

- User-wide MCP connections no longer require Browser Testbench to be installed globally.
- MCP clients now use a persistent, project-independent launcher that remains functional when their process cannot resolve Node, npm, or project binaries through `PATH`.
- Existing project-dependent MCP registrations are detected as outdated and can be replaced automatically.
- Setup status now states that MCP configuration applies to new client sessions and requires a restart before its tools become available.

## [0.1.3] - 2026-09-16

### Fixed

- MCP client detection now works when Codex, Claude Code, Gemini CLI, or the VS Code launcher is installed outside the server process `PATH`.
- Codex bundled with the OpenAI VS Code extension and platform-specific VS Code installations are now detected automatically.
- MCP registrations now use the resolved client executable and can replace connections to a different Browser Testbench installation.
- Explicit executable path overrides provide actionable status messages when a client cannot be started.

## [0.1.2] - 2026-09-16

### Fixed

- Runtime dependencies such as Appium and Font Awesome are now resolved correctly when npm hoists them in workspace and project installations.
- Mutable Testbench data is now stored in a stable, platform-specific user data directory instead of inside the installed npm package.
- Closing an iOS session now shuts down its target Simulator and cleans up WebDriverAgent.
- The initial Safari verification can now run while Safari is waiting for its one-time WebDriver confirmation.

## [0.1.1] - 2026-09-16

### Fixed

- Element waits now keep polling when matching elements are not yet present instead of failing immediately.
- Value, attribute, and element-text waits now support dynamically rendered elements consistently.

## [0.1.0] - 2026-09-16

### Added

- Cross-platform remote control for Chrome, Firefox, Edge, Safari, iOS Simulator, and Android Emulator targets.
- Interactive web interface for environment setup, target discovery, verification, debugging, and local documentation.
- Project-independent Node.js client, REST API, CLI, and MCP integration.
- Browser interaction, form automation, waits, screenshots, diagnostics, mobile gestures, orientation, and video recording.
- Convention-based target IDs and parallel execution across multiple targets.
- Dynamic Android AVD discovery and provisioning without fixed API levels or Pixel profiles.
- Automated CI for macOS, Windows, and Linux and npm publishing through GitHub Actions.

[Unreleased]: https://github.com/llakie/browser-testbench/compare/v0.4.0...HEAD
[0.5.0]: https://github.com/llakie/browser-testbench/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/llakie/browser-testbench/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/llakie/browser-testbench/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/llakie/browser-testbench/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/llakie/browser-testbench/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/llakie/browser-testbench/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/llakie/browser-testbench/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/llakie/browser-testbench/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/llakie/browser-testbench/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/llakie/browser-testbench/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/llakie/browser-testbench/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/llakie/browser-testbench/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/llakie/browser-testbench/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/llakie/browser-testbench/releases/tag/v0.1.0
