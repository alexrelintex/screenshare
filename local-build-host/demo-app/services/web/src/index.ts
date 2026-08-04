import { createServer } from "node:http";
import { formatTotal } from "./format.js";

// API_URL is injected by docker compose; falls back to localhost for bare-metal runs.
const API_URL = process.env.API_URL ?? "http://localhost:8000";
const PORT = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  try {
    const upstream = await fetch(`${API_URL}/sum`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [1, 2, 3.5] }),
    });
    const data = (await upstream.json()) as { total: number; count: number };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(formatTotal(data.total, data.count) + "\n");
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream failed: ${(err as Error).message}\n`);
  }
});

server.listen(PORT, () => console.log(`web listening on ${PORT}, api at ${API_URL}`));
