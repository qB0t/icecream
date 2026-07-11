// Vercel serverless function: forwards TICE orders to Telegram and stores them for status tracking.
// Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_BOT_USERNAME (optional),
// KV_REST_API_URL + KV_REST_API_TOKEN (auto-added by Vercel Upstash Redis integration; optional — enables tracking).
import { kv, hasKV, verifyToken, ORDER_RE, tgSend } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method" });
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    res.status(500).json({ ok: false, error: "not_configured" });
    return;
  }
  const { text, orderId, items, total, location } = req.body || {};
  if (typeof text !== "string" || text.length < 10 || text.length > 4000 || !text.startsWith("🍦 TICE ORDER")) {
    res.status(400).json({ ok: false, error: "bad_request" });
    return;
  }
  const id = typeof orderId === "string" && ORDER_RE.test(orderId) ? orderId : null;
  // optional: link order to a signed-in account
  const email = verifyToken(req.headers["authorization"]);
  const safeItems = Array.isArray(items) && JSON.stringify(items).length <= 8000 ? items : null;
  const safeTotal = typeof total === "number" && total > 0 && total < 100000 ? total : null;
  const safeLoc = location && typeof location.lat === "number" && typeof location.lng === "number"
    ? { lat: location.lat, lng: location.lng } : null;
  try {
    const j = await tgSend(token, chatId, text);
    let tracking = false;
    if (j.ok && id && hasKV()) {
      try {
        const now = Date.now();
        const order = { id, text, status: "new", ts: now, updatedAt: now, chatId: null,
          email: email || null, items: safeItems, total: safeTotal, location: safeLoc };
        await kv(["SET", "order:" + id, JSON.stringify(order)]);
        await kv(["ZADD", "orders", String(now), id]);
        if (email) await kv(["ZADD", "uorders:" + email, String(now), id]);
        tracking = true;
      } catch (e) { /* tracking is optional */ }
    }
    res.status(j.ok ? 200 : 502).json({ ok: !!j.ok, bot: process.env.TELEGRAM_BOT_USERNAME || null, tracking });
  } catch (e) {
    res.status(502).json({ ok: false, error: "telegram_unreachable" });
  }
}
