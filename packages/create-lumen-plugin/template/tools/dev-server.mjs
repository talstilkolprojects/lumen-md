#!/usr/bin/env node
/**
 * Lumen plugin dev server (plan W3.10): serves this folder to the app on
 * your computer and tells it when a file changes, so the plugin reloads
 * by itself (hot reload).
 *
 *   npm run dev                 # http://127.0.0.1:5199
 *   PORT=5200 npm run dev     # tests only: the app's CSP allows port 5199
 *
 * In Lumen: Plugin gallery → Developer mode → "Connect" (the address above).
 * Only 127.0.0.1 is listened on; files outside this folder are never
 * served. Zero dependencies.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = { ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".md": "text/markdown", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const IGNORED = /(^|[\\/])(node_modules|\.git|test)([\\/]|$)|~$|\.swp$/;

/** Start the server on `port` (0 = any free one) serving `dir`. → { url, close, clients } */
export function startDevServer({ dir = process.cwd(), port = 5199, debounceMs = 30, log = console.log } = {}) {
  const root = resolve(dir);
  const clients = new Set();
  let timer = null;
  let changed = new Set();
  const notify = () => {
    const files = [...changed];
    changed = new Set();
    const msg = `event: change\ndata: ${JSON.stringify({ files, at: Date.now() })}\n\n`;
    for (const res of clients) res.write(msg);
    log(`changed: ${files.join(", ")} → ${clients.size} app(s) reloading`);
  };
  const watcher = watch(root, { recursive: true }, (_ev, file) => {
    if (!file || IGNORED.test(file)) return;
    changed.add(String(file).split(sep).join("/"));
    clearTimeout(timer);
    timer = setTimeout(notify, debounceMs);
  });

  const server = createServer(async (req, res) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (req.method === "OPTIONS") return res.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET" }).end();
    if (path === "/events") {
      res.writeHead(200, { ...headers, "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const file = normalize(join(root, path === "/" ? "lumen-plugin.json" : path));
    if (!file.startsWith(root + sep) || IGNORED.test(file.slice(root.length))) return res.writeHead(404, headers).end("not found");
    try {
      if (!(await stat(file)).isFile()) throw new Error("dir");
      res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, headers).end("not found");
    }
  });

  return new Promise((ok) =>
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      log(`Lumen plugin dev server: ${url}\nIn Lumen: Plugin gallery → Developer mode → Connect → ${url}`);
      ok({
        url,
        clients,
        close: () =>
          new Promise((done) => {
            watcher.close();
            clearTimeout(timer);
            for (const r of clients) r.end();
            server.close(() => done());
          }),
      });
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startDevServer({ dir: process.cwd(), port: Number(process.env.PORT) || 5199 });
}
