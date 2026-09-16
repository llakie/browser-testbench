# Changelog

All notable changes to Browser Testbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-09-16

### Fixed

- Runtime dependencies such as Appium and Font Awesome are now resolved correctly when npm hoists them in workspace and project installations.
- Mutable Testbench data is now stored in a stable, platform-specific user data directory instead of inside the installed npm package.
- Closing an iOS session now shuts down its target Simulator and cleans up WebDriverAgent.

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

[0.1.2]: https://github.com/llakie/browser-testbench/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/llakie/browser-testbench/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/llakie/browser-testbench/releases/tag/v0.1.0
