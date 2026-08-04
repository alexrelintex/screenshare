// Minimal static server for the demo page and the built bundle.
// Development and testing only — not a production asset host.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(".");
const PORT = Number(process.env.PORT ?? 5173);

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
  let target = resolve(join(ROOT, normalize(decodeURIComponent(url.pathname))));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404).end("not found");
    return;
  }
  // Serve index.html for directory requests
  if (statSync(target).isDirectory()) {
    target = join(target, "index.html");
    if (!existsSync(target)) {
      res.writeHead(404).end("not found");
      return;
    }
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
  console.log(`  host   http://127.0.0.1:${PORT}/demo/index.html?room=demo&mode=host`);
  console.log(`  viewer http://127.0.0.1:${PORT}/demo/index.html?room=demo&mode=viewer`);
});
