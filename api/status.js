// Public order status lookup: GET /api/status?id=TICE-XXXXX
import { kv, ORDER_RE } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") { res.status(405).json({ ok: false }); return; }
  const id = req.query && req.query.id;
  if (typeof id !== "string" || !ORDER_RE.test(id)) {
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
