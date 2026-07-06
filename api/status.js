// Public order status lookup: GET /api/status?id=TICE-XXXXX
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

export default async function handler(req, res) {
  if (req.method !== "GET") { res.status(405).json({ ok: false }); return; }
  const id = req.query && req.query.id;
  if (typeof id !== "string" || !/^TICE-[A-Z0-9]{4,12}$/.test(id)) {
    res.status(400).json({ ok: false, error: "bad_id" });
    return;
  }
  try {
    const raw = await kv(["GET", "order:" + id]);
    if (!raw) { res.status(404).json({ ok: false, error: "not_found" }); return; }
    const o = JSON.parse(raw);
    // public endpoint: expose status only, never the order contents
    res.status(200).json({ ok: true, id: o.id, status: o.status, updatedAt: o.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: "kv_error" });
  }
}
