# Browser Testbench

Eine lokale, projektunabhängige Fernsteuerung für reale Desktopbrowser sowie iOS- und Android-Simulatoren.

Die Verantwortungsgrenze ist bewusst eindeutig:

- Die Testbench erkennt, startet und steuert Browser und simulierte Geräte.
- Das Projekt startet seinen eigenen Entwicklungsserver und besitzt Testabläufe, URLs, Assertions und Ergebnisdateien.
- KI-Assistenten greifen über MCP auf dieselben Steuerbefehle zu.

Die Testbench importiert keine Testdateien aus einem Projekt und führt keinen fremden Test-Runner aus.

## Unterstützte Ziele

| Ziel                       | macOS | Windows | Linux |
| -------------------------- | ----- | ------- | ----- |
| Chrome                     | ja    | ja      | ja    |
| Firefox                    | ja    | ja      | ja    |
| Safari                     | ja    | –       | –     |
| Edge                       | ja    | ja      | ja    |
| Safari im iOS-Simulator    | ja    | –       | –     |
| Chrome im Android-Emulator | ja    | ja      | ja    |

Mobile Sessions werden über Appium mit XCUITest beziehungsweise UiAutomator2 gesteuert. Die Weboberfläche erkennt installierte Browser, Simulatoren, Emulatoren und notwendige Einrichtungsschritte.

## Installation und Start

```bash
npm install
npm run build
npm run dev -- serve
```

Standardmäßig läuft die Oberfläche unter `http://127.0.0.1:55808/setup` und wird beim Start geöffnet. Eine andere Adresse ist möglich:

```bash
npm run dev -- serve --port 7788 --no-open
```

Bei einer Bindung außerhalb von Loopback ist ein Bearer-Token Pflicht:

```bash
npm run dev -- serve --host 0.0.0.0 --token "$BROWSER_TESTBENCH_TOKEN"
```

Safari wird aus Rücksicht auf macOS-Berechtigungsdialoge nicht automatisch gestartet. Einmalig erforderlich:

```bash
sudo safaridriver --enable
npm run dev -- verify safari
```

## Zwei Arbeitsweisen

### Interaktiv entwickeln und debuggen

Ein KI-Assistent kann über MCP eine Session öffnen, navigieren, Elemente untersuchen, klicken, tippen, Screenshots erzeugen und mobile Gesten auslösen. Console-Ausgaben und HTTP-Requests/-Responses sind über `get_diagnostics` verfügbar. WebSocket-Transport und WebSocket-Frame-Inspektion sind aktuell nicht Bestandteil der Testbench.

Für native Browser-DevTools liefert `get_devtools_instructions` die passende Verbindung:

- iOS-Simulator: Safari Web Inspector über das Entwickeln-Menü von Safari.
- Android-Emulator: Chrome DevTools über `chrome://inspect/#devices`.
- Chromium auf dem Desktop: Console- und Netzwerkdiagnostik direkt über die Testbench; die normalen Browser-DevTools können zusätzlich manuell geöffnet werden.

### Automatisierte Projekttests

Die Weboberfläche erzeugt eine kleine Verbindungsdatei:

```json
{
  "server": "http://127.0.0.1:55808",
  "targetPolicy": "available",
  "targets": [
    { "name": "chrome", "headless": true },
    { "name": "safari-ios", "deviceName": "iPhone 17 Pro", "platformVersion": "25.5" }
  ]
}
```

Diese Datei enthält absichtlich keine Anwendungsadresse, Testdateien oder Ergebnisordner. Solche Angaben gehören in das Projekt.

Installiere den Client aus dem lokalen Testbench-Verzeichnis; der genaue Befehl wird in der Weboberfläche angezeigt. Danach kann jeder Node-basierte Test-Runner dieselbe Fernsteuerung verwenden:

```js
import assert from "node:assert/strict";
import { RemoteTestbench } from "browser-testbench/client";
import config from "./testbench.config.json" with { type: "json" };

const testbench = new RemoteTestbench(config);
const browser = await testbench.open({
  target: "chrome",
  url: "http://127.0.0.1:5173/login",
});

try {
  await browser.type("#email", "test@example.com");
  await browser.click("button=Anmelden");
  await browser.waitForText("Willkommen");
  assert.match((await browser.inspect()).url, /dashboard/);
  await browser.screenshot("artifacts/login.png");
} finally {
  await browser.close();
}
```

Bei einem konfigurierten mobilen Ziel übernimmt `open()` automatisch dessen `deviceName`, `platformVersion`, `udid` oder `avd`, solange der Aufruf nur das Ziel überschreibt.

## Node-Client

`RemoteTestbench` bietet:

- `capabilities()` und `availableTargets()`
- `open({ target, url, ... })`

Eine `RemoteSession` bietet:

- `navigate()`, `inspect()`, `click()` und `type()`
- `waitForElement()`, `waitForText()` und `waitForUrl()`
- `tap()`, `swipe()` und `pinch()` für mobile Ziele
- `screenshot()` und `screenshotBase64()`
- `diagnostics()` und `devtools()`
- `close()`

Screenshots werden vom Client im Projekt gespeichert. Der Server benötigt deshalb keinen Pfad in das Projekt.

## MCP

Die Weboberfläche erzeugt oder installiert die Konfiguration für Codex, Claude Code, Gemini CLI, GitHub Copilot in VS Code und andere MCP-Clients. Der MCP-Server verwendet `stdio`:

```bash
npm run dev -- mcp
```

Wichtige Werkzeuge:

- Umgebung: `list_targets`, `doctor`
- Session: `start_session`, `navigate`, `inspect_page`, `close_session`
- Bedienung: `click`, `type`, `tap`, `swipe`, `pinch`
- Synchronisierung: `wait_for_element`, `wait_for_text`, `wait_for_url`
- Debugging: `get_page_source`, `take_screenshot`, `get_diagnostics`, `get_devtools_instructions`

## REST-API

```text
GET    /health
GET    /v1/capabilities
GET    /v1/doctor
GET    /v1/workbench
POST   /v1/workbench/setup
POST   /v1/workbench/mcp
GET    /v1/events

GET    /v1/sessions
POST   /v1/sessions
DELETE /v1/sessions/:id
GET    /v1/sessions/:id/inspect
POST   /v1/sessions/:id/navigate
POST   /v1/sessions/:id/click
POST   /v1/sessions/:id/type
POST   /v1/sessions/:id/wait
POST   /v1/sessions/:id/gesture
POST   /v1/sessions/:id/screenshot
GET    /v1/sessions/:id/diagnostics
GET    /v1/sessions/:id/devtools
```

Mehrere Sessions können gleichzeitig bestehen. Mobile Ziele bleiben wegen ihrer Treiber und Geräte typischerweise seriell zu verwenden. Statusereignisse laufen über Server-Sent Events; für normale Client-Aufrufe genügt REST.

## Kommandozeile

```text
browser-testbench serve [--host 127.0.0.1] [--port 55808] [--token ...] [--no-open]
browser-testbench targets [--server URL] [--token ...] [--json]
browser-testbench doctor [--targets ...] [--json]
browser-testbench setup [--targets ...] [--android-avd NAME] [--yes] [--json]
browser-testbench verify <target> [--headless]
browser-testbench open --target <target> --url <url>
browser-testbench screenshot --target <target> --url <url> [--output file]
browser-testbench mcp
browser-testbench mcp-config --client <client>
```

## Entwicklung

```bash
npm run format
npm run check
npm test
BTB_BROWSER_TESTS=1 npm test
npm run build
```

Browser-Integrationstests starten ausschließlich Chrome im Headless-Modus. Safari oder Simulatoren werden nie ungefragt als Teil der automatischen Tests geöffnet.
