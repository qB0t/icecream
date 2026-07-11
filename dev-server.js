// Local dev server: emulates Vercel's runtime for this project. No dependencies.
//   node dev-server.js          (or: npm run dev)
//
// - Serves static files with cleanUrls (/, /admin) like vercel.json.
// - Routes /api/<name> to api/<name>.js with Vercel-style req/res (body, query,
//   res.status().json()). Handlers are re-imported when their file changes,
//   so API edits don't need a restart (static files never did).
// - Reads .env.local for real secrets if you create one (KEY=value lines).
// - Anything not configured falls back to a built-in mock:
//     * in-memory KV at /__kv (Upstash REST protocol subset) — orders, users,
//       catalog work locally but vanish on restart
//     * fake Telegram at /__telegram — messages are printed to this console
//       instead of being sent
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------- env: .env.local then mock fallbacks ----------
const envFile = path.join(ROOT, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const mocked = [];
function def(key, val, label) {
  if (!process.env[key]) { process.env[key] = val; mocked.push(label || key); }
}
def("AUTH_SECRET", "dev-only-secret-not-for-production");
def("ADMIN_KEY", "dev", "ADMIN_KEY (use 'dev' in admin.html)");
if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) {
  process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}/__kv`;
  process.env.KV_REST_API_TOKEN = "dev";
  mocked.push("KV (in-memory, resets on restart)");
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${PORT}/__telegram`;
  process.env.TELEGRAM_BOT_TOKEN = "dev";
  process.env.TELEGRAM_CHAT_ID = "1";
  mocked.push("Telegram (messages print to this console)");
}

// ---------- mock KV: the subset of Upstash REST the app uses ----------
const kvStr = new Map();               // key -> string
const kvZ = new Map();                 // key -> Map(member -> score)
function kvExec([cmd, ...a]) {
  switch (String(cmd).toUpperCase()) {
    case "GET": return kvStr.get(a[0]) ?? null;
    case "SET": kvStr.set(a[0], a[1]); return "OK";
    case "DEL": { const n = kvStr.delete(a[0]) ? 1 : 0; kvZ.delete(a[0]); return n; }
    case "MGET": return a.map((k) => kvStr.get(k) ?? null);
    case "ZADD": {
      const z = kvZ.get(a[0]) || kvZ.set(a[0], new Map()).get(a[0]);
      z.set(a[2], Number(a[1]));
      return 1;
    }
    case "ZRANGE": {
      const z = kvZ.get(a[0]);
      if (!z) return [];
      const sorted = [...z.entries()].sort((x, y) => x[1] - y[1]).map((e) => e[0]);
      let [start, stop] = [Number(a[1]), Number(a[2])];
      if (start < 0) start = Math.max(0, sorted.length + start);
      if (stop < 0) stop = sorted.length + stop;
      return sorted.slice(start, stop + 1);
    }
    default: throw new Error("mock kv: unsupported command " + cmd);
  }
}

// ---------- Vercel-style req/res shims ----------
function makeRes(res) {
  return {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return this; },
    json(obj) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(obj));
    },
    end: (d) => res.end(d),
  };
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return raw; }
}

// re-import an api module when its file changes
async function loadHandler(name) {
  const file = path.join(ROOT, "api", name + ".js");
  if (!fs.existsSync(file)) return null;
  const v = fs.statSync(file).mtimeMs;
  const mod = await import(pathToFileURL(file).href + "?v=" + v);
  return mod.default;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);
  try {
    // mock endpoints
    if (p === "/__kv") {
      const cmd = await readBody(req);
      try { res.end(JSON.stringify({ result: kvExec(cmd) })); }
      catch (e) { res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (p.startsWith("/__telegram/")) {
      const body = await readBody(req);
      console.log(`\x1b[36m[telegram → chat ${body?.chat_id}]\x1b[0m ${body?.text}\n`);
      res.end(JSON.stringify({ ok: true, result: { message_id: Date.now() } }));
      return;
    }
    // api functions
    if (p.startsWith("/api/")) {
      const name = p.slice(5).replace(/\/$/, "");
      if (!/^[a-z]+$/.test(name)) { res.statusCode = 404; res.end("not found"); return; }
      const handler = await loadHandler(name);
      if (!handler) { res.statusCode = 404; res.end("no such function"); return; }
      req.query = Object.fromEntries(url.searchParams);
      req.body = await readBody(req);
      await handler(req, makeRes(res));
      return;
    }
    // static with cleanUrls
    let rel = p === "/" ? "index.html" : p.slice(1);
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
    if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404; res.end("not found"); return;
    }
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end("dev server error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n🍦 TICE dev server → http://localhost:${PORT}  (admin: /admin)`);
  if (mocked.length) console.log("   mocked locally: " + mocked.join(", "));
  console.log("   real secrets can go in .env.local (never committed)\n");
});
