import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4173);
createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>Portable Testbench Example</title></head>
      <body>
        <main>
          <h1>Portable Testbench Example</h1>
          <label>Name <input id="name" aria-label="Name"></label>
          <button id="submit">Submit</button>
          <output id="result"></output>
        </main>
        <script>document.querySelector('#submit').onclick = () => document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value;</script>
      </body>
    </html>`);
}).listen(port, "0.0.0.0", () => console.log(`Example listening on http://127.0.0.1:${port}`));
