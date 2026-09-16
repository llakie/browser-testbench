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

`verify` akzeptiert jede konkrete ID aus `browser-testbench targets` und führt den Test über den laufenden
Testbench-Server aus. Derselbe Test kann in der Weboberfläche mit „Testlauf starten“ bewusst ausgelöst werden.

## Zwei Arbeitsweisen

### Interaktiv entwickeln und debuggen

Ein KI-Assistent kann über MCP eine Session öffnen, navigieren, Elemente untersuchen, klicken, tippen, Screenshots erzeugen und mobile Gesten auslösen. Der MCP-Prozess arbeitet dabei als schlanke Brücke zum laufenden Testbench-Server; Zielauflösung, Sessions und Gerätesperren bleiben zentral. Console-Ausgaben und HTTP-Requests/-Responses sind über `get_diagnostics` verfügbar. WebSocket-Transport und WebSocket-Frame-Inspektion sind aktuell nicht Bestandteil der Testbench.

Für native Browser-DevTools liefert `get_devtools_instructions` die passende Verbindung:

- iOS-Simulator: Safari Web Inspector über das Entwickeln-Menü von Safari.
- Android-Emulator: Chrome DevTools über `chrome://inspect/#devices`.
- Chromium auf dem Desktop: Console- und Netzwerkdiagnostik direkt über die Testbench; die normalen Browser-DevTools können zusätzlich manuell geöffnet werden.

### Automatisierte Projekttests

Die Testbench erzeugt für jeden erkannten Browser und jedes kompatible simulierte Gerät eine stabile ID. Beispielsweise
heißen Ziele `chrome` oder `safari-ios-iphone-17-pro-26-5`. Die Weboberfläche zeigt alle IDs mit Kopierfunktion an.
Eine Projekt-Konfigurationsdatei ist nicht erforderlich.

Installiere den Client aus dem lokalen Testbench-Verzeichnis; der genaue Befehl wird in der Weboberfläche angezeigt. Danach kann jeder Node-basierte Test-Runner dieselbe Fernsteuerung verwenden:

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
    await browser.waitForText("Willkommen");
    assert.match((await browser.inspect()).url, /dashboard/);
    await browser.screenshot(`artifacts/login-${target}.png`);
  } finally {
    await browser.close();
  }
}
```

`availableTargets()` behält die angefragte Reihenfolge bei und überspringt Ziele, die auf dem aktuellen Rechner nicht
einsatzbereit sind. Ist kein einziges angefragtes Ziel bereit, wird das Promise rejected. Die Testbench löst eine mobile
ID intern zu `deviceName`, Plattformversion und UDID beziehungsweise AVD auf. `headless` wird für mobile Ziele ignoriert.

Für parallele Ausführung steht außerdem `forEachTarget()` bereit. Verschiedene Geräte können parallel laufen; Zugriffe
auf dasselbe serielle Ziel werden serverseitig nacheinander ausgeführt.

## Node-Client

`RemoteTestbench` verbindet sich ohne Argumente mit `http://127.0.0.1:55808`. Eine andere Adresse kann über
`BROWSER_TESTBENCH_URL` oder den Konstruktor gesetzt werden. Der Client bietet:

- `targets()`, `capabilities()` und `availableTargets([...])`
- `open({ target, url, ... })`
- `forEachTarget(targets, options, callback)`

Eine `RemoteSession` bietet:

- Formulare: `fill()`, `append()`, `clear()`, `check()`, `uncheck()`, `select()`, `upload()` und `submit()`
- Zustand: `state()`, `count()`, `inspect()`, `cookies()` und `storage()`
- Eingabe: `click()`, `press()`, `focus()`, `blur()`, `hover()`, `doubleClick()`, `rightClick()` und `drag()`
- Navigation: `navigate()`, `back()`, `forward()`, `refresh()`, Tabs/Fenster und Frames
- Warten: Element, Text, URL, Wert, Anzahl und Zustände wie sichtbar, entfernt, aktiviert oder ausgewählt
- Browserzustand: Cookies, Local/Session Storage, Dialoge und Viewport
- Dateien: Upload, projektseitige Screenshots und Downloads mit konfiguriertem `downloadDir`
- Debugging: Vollseiten-/Element-Screenshots, PDF, Accessibility-Baum, Zwischenablage und JavaScript-Auswertung
- Umgebung: Netzwerkbedingungen, blockierte URLs, Fetch-Mocks, Geolocation und Berechtigungen auf Chromium-Zielen
- `tap()`, `swipe()` und `pinch()` für mobile Ziele
- Mobil: Orientierung, Zurück-Taste, Tastatur schließen und optionale MP4-Aufzeichnung
- `diagnostics()`, `clearDiagnostics()` und `devtools()`
- `close()`

Alle Elementmethoden akzeptieren ausschließlich standardkonforme CSS-Selektoren. Verwende für robuste Tests bevorzugt
stabile Attribute wie IDs, `name` oder `data-testid`, beispielsweise `#login`, `input[name="email"]` oder
`[data-testid="terms"]`. Für offene Shadow Roots steht bei Bedarf `evaluate()` mit `shadowRoot.querySelector()` zur
Verfügung.

Screenshots werden vom Client im Projekt gespeichert. Für Downloads wird beim Öffnen der Session ein `downloadDir`
auf dem Testbench-Rechner angegeben.

`mockFetch()` ersetzt Fetch-Antworten in der aktuell geladenen Seite. `blockUrls()`, Netzwerkbedingungen,
Geolocation, Berechtigungen, PDF und der native Accessibility-Baum verwenden Chromium DevTools und sind daher für
Chrome und Edge gedacht. Auf anderen Zielen bleiben die WebDriver-basierten Formular-, Navigations- und
Zustandsfunktionen verfügbar. Für mobile Videos wird `videoPath` beim Öffnen der Session gesetzt; die Aufzeichnung
wird beim Schließen der Session abgeschlossen.

## MCP

Die Weboberfläche erzeugt oder installiert die Konfiguration für Codex, Claude Code, Gemini CLI, GitHub Copilot in VS Code und andere MCP-Clients. Der MCP-Server verwendet `stdio`:

```bash
npm run dev -- mcp
```

Wichtige Werkzeuge:

- Umgebung: `list_targets`, `doctor`, `verify_target`
- Session: `start_session`, `navigate`, `inspect_page`, `close_session`
- Bedienung: `click`, `type`, `element_action`, `browser_action`, `tap`, `swipe`, `pinch`
- Synchronisierung: `wait_for_element`, `wait_for_text`, `wait_for_url`, `wait_for_state`, `wait_for_value`, `wait_for_count`
- Debugging: `get_page_source`, `take_screenshot`, `get_diagnostics`, `clear_diagnostics`, `get_devtools_instructions`

## REST-API

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

Mehrere Sessions können gleichzeitig bestehen. Mobile Ziele bleiben wegen ihrer Treiber und Geräte typischerweise seriell zu verwenden. Alle Client-Aufrufe laufen über die zentrale REST-API.

## Kommandozeile

```text
browser-testbench serve [--host 127.0.0.1] [--port 55808] [--token ...] [--no-open]
browser-testbench targets [--server URL] [--token ...] [--json]
browser-testbench doctor [--targets ...] [--json]
browser-testbench setup [--targets ...] [--android-avd NAME] [--yes] [--json]
browser-testbench verify <target-id> [--headless] [--server URL] [--token ...]
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
