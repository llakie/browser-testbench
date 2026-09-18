import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";

export class FixtureServer {
  private readonly server = createServer((request, response) => {
    if (request.url === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html><body><button id="frame-button">Frame action</button></body></html>');
      return;
    }
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="fixture.txt"',
      });
      response.end("Browser Testbench download");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html>
      <html>
        <head><title>Browser Testbench Fixture</title></head>
        <body>
          <main>
            <h1>Browser Testbench</h1>
            <form id="fixture-form" onsubmit="event.preventDefault()">
              <label>Name <input id="name" name="name" placeholder="Your name"></label>
              <label><input id="terms" type="checkbox"> Accept terms</label>
              <label>Country
                <select id="country"><option value="de">Germany</option><option value="gb">United Kingdom</option></select>
              </label>
              <input id="upload" type="file">
              <button id="submit" data-testid="submit" role="button" onclick="console.log('fixture submitted'); fetch('/api/ping'); document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value">Submit</button>
            </form>
            <button id="alert" onclick="alert('Fixture alert')">Alert</button>
            <a id="download" href="/download">Download</a>
            <iframe id="fixture-frame" src="/frame"></iframe>
            <div id="shadow-host"></div>
            <script>
              document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-button">Shadow action</button>';
            </script>
            <p id="result"></p>
            <ul><li class="item">One</li><li class="item">Two</li></ul>
          </main>
        </body>
      </html>`,
    );
  });

  constructor() {
    this.server.on("upgrade", (request, socket) => {
      if (request.url !== "/websocket" || !request.headers["sec-websocket-key"]) {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );
      socket.on("data", (data) => {
        const opcode = data[0]! & 0x0f;
        if (opcode === 1) socket.write(this.webSocketTextFrame(`echo:${this.webSocketPayload(data)}`));
        if (opcode === 8) socket.end(Buffer.from([0x88, 0x00]));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "0.0.0.0", resolve);
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private webSocketPayload(frame: Buffer): string {
    const flags = frame[1]!;
    const masked = Boolean(flags & 0x80);
    const length = flags & 0x7f;
    const maskOffset = 2;
    const payloadOffset = masked ? maskOffset + 4 : maskOffset;
    const payload = Buffer.from(frame.subarray(payloadOffset, payloadOffset + length));
    if (masked) {
      const mask = frame.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!;
    }
    return payload.toString("utf8");
  }

  private webSocketTextFrame(payload: string): Buffer {
    const body = Buffer.from(payload);
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
}
