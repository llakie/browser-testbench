# Contributing

Thank you for helping improve Browser Testbench.

## Before you start

- Search existing issues before opening a new one.
- Use a bug report for reproducible defects and a feature request for proposed behavior.
- Keep changes focused and independent of any particular application under test.
- Do not commit generated output, caches, dependencies, credentials, recordings, or test artifacts.

## Development setup

Browser Testbench requires Node.js 22.12 or 24 and newer.

```bash
git clone https://github.com/llakie/browser-testbench.git
cd browser-testbench
npm ci
npm run dev -- start
```

The setup interface opens at `http://127.0.0.1:55808/setup` by default.

## Validation

Run the complete local verification before submitting a pull request:

```bash
npm run format:check
npm run check
npm test
npm run build
```

Opt-in browser integration tests launch Chrome in headless mode:

```bash
BTB_BROWSER_TESTS=1 npm test
```

On Windows PowerShell:

```powershell
$env:BTB_BROWSER_TESTS = "1"
npm test
```

Changes to platform integration should also be verified on the affected operating system and real browser, simulator, or emulator whenever possible. Include the tested platform and target versions in the pull request.

## Pull requests

- Explain the problem and the resulting behavior.
- Add or update tests for behavior changes.
- Update user-facing documentation when commands, APIs, or setup steps change.
- Preserve backward compatibility unless the change is explicitly documented as breaking.
- Keep commits understandable and free of unrelated formatting or refactoring.

By contributing, you agree that your contributions are licensed under the project's MIT License.
