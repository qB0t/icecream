// Account: order history + claiming orders placed before signing in.
// Auth: Authorization: Bearer <token from /api/auth>
// GET  /api/account            -> { ok, orders: [{id,status,ts,total,items}] } newest first
// POST /api/account {claim:id} -> { ok } attaches an unowned order to this account
import crypto from "node:crypto";
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
function verifyToken(hdr) {
  const SECRET = process.env.AUTH_SECRET;
  if (!SECRET || !hdr || !hdr.startsWith("Bearer ")) return null;
  const parts = hdr.slice(7).split(".");
  if (parts.length !== 2) return null;
  const sig = crypto.createHmac("sha256", SECRET).update(parts[0]).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (!o.e || o.x < Date.now()) return null;
    return o.e;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  const email = verifyToken(req.headers["authorization"]);
  if (!email) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  if (!KV_URL || !KV_TOKEN) { res.status(500).json({ ok: false, error: "kv_not_configured" }); return; }
  try {
    if (req.method === "GET") {
      const ids = (await kv(["ZRANGE", "uorders:" + email, "-50", "-1"])) || [];
      let orders = [];
      if (ids.length) {
        const raws = await kv(["MGET", ...ids.map((i) => "order:" + i)]);
        orders = raws.filter(Boolean).map((r) => {
          const o = JSON.parse(r);
          return { id: o.id, status: o.status, ts: o.ts, total: o.total || null, items: o.items || null, text: o.text || null };
        }).reverse();
      }
      res.status(200).json({ ok: true, email, orders });
      return;
    }
    if (req.method === "POST") {
      const id = req.body && req.body.claim;
      if (typeof id !== "string" || !/^TICE-[A-Z0-9]{4,12}$/.test(id)) {
        res.status(400).json({ ok: false, error: "bad_request" });
        return;
      }
      const raw = await kv(["GET", "order:" + id]);
      if (!raw) { res.status(404).json({ ok: false, error: "not_found" }); return; }
      const order = JSON.parse(raw);
      if (order.email && order.email !== email) { res.status(403).json({ ok: false, error: "owned" }); return; }
      if (!order.email) {
        order.email = email;
        await kv(["SET", "order:" + id, JSON.stringify(order)]);
      }
      await kv(["ZADD", "uorders:" + email, String(order.ts || Date.now()), id]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ ok: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: "kv_error" });
  }
}
