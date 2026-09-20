# Changelog

All notable changes to Browser Testbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Physical iPhones and iPads connected by USB are detected and exposed as Safari targets alongside iOS Simulators.
- Older physical iPhones that Xcode exposes through `xcdevice` but not CoreDevice are detected through a bounded
  compatibility fallback.
- Guided physical-iOS setup covers device trust, Developer Mode, Safari automation settings, WebDriverAgent signing,
  free Personal Teams, paid Developer teams, multi-team selection, and seven-day free-profile renewal failures.
- Physical iOS connection changes now update open web interfaces automatically.

### Changed

- Physical iOS sessions receive deterministic signing capabilities and reject unreachable loopback application URLs
  before starting, while internal verification uses the host's LAN address.
- Simulator-only cleanup is no longer applied to physical Apple devices.

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

[Unreleased]: https://github.com/llakie/browser-testbench/compare/v0.2.0...HEAD
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
