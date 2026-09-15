import type { AddressInfo } from "node:net";
import { createServer } from "node:http";

export class FixtureServer {
  private readonly server = createServer((request, response) => {
    if (request.url === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>Browser Testbench Fixture</title></head><body><main><h1>Browser Testbench</h1><label>Name <input id=\"name\"></label><button id=\"submit\" onclick=\"console.log('fixture submitted'); fetch('/api/ping'); document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value\">Submit</button><p id=\"result\"></p></main></body></html>",
    );
  });

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
}
