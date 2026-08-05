// Minimal static server for the demo page and the built bundle.
// Development and testing only — not a production asset host.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(".");
const PORT = Number(process.env.PORT ?? 5173);
// Loopback by default: this serves the repo directory with no auth, and on a
// laptop that should not be reachable from the network. A container has to opt
// in with HOST=0.0.0.0 — binding loopback inside a container means the port
// Docker publishes accepts nothing, which looks like a hang from the host.
const HOST = process.env.HOST ?? "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // normalize + prefix check: without this, /../../etc/passwd escapes ROOT.
  const target = resolve(join(ROOT, normalize(decodeURIComponent(url.pathname))));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(res);
}).listen(PORT, HOST, () => {
  // A wildcard bind is not an address anyone can open; print something usable.
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
  console.log(`serving ${ROOT} on http://${shown}:${PORT} (bound ${HOST})`);
  console.log(`  host   http://${shown}:${PORT}/demo/index.html?room=demo&mode=host`);
  console.log(`  viewer http://${shown}:${PORT}/demo/index.html?room=demo&mode=viewer`);
});
