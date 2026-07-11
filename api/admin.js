// Admin API: list orders + update status (notifies customer via bot if connected).
// Auth: x-admin-key header must equal ADMIN_KEY env var.
// GET  /api/admin            -> { ok, orders: [...] } (newest first, last 100)
// POST /api/admin {id,status}-> { ok, notified }
import { kv, hasKV, ORDER_RE, tgSend } from "./_lib.js";

const STATUSES = ["new", "accepted", "churning", "delivery", "done", "cancelled"];
const CUSTOMER_MSG = {
  accepted: "✅ Order %ID% is accepted! I'll write here when it goes into the machine.\n\nЗаказ %ID% принят! Напишу здесь, когда он отправится в машину.",
  churning: "🍦 %ID%: your ice cream is churning right now — fresh, small batch.\n\n%ID%: ваше мороженое прямо сейчас взбивается — свежая малая партия.",
  delivery: "🛵 %ID% is frozen, packed and on the way to you!\n\n%ID% заморожен, упакован и уже едет к вам!",
  done: "🎉 %ID% delivered — enjoy! Keep it at −18 °C, best within a week.\n\n%ID% доставлен — приятного! Храните при −18 °C, лучше съесть за неделю.",
  cancelled: "✖️ Order %ID% was cancelled. If that's unexpected — write me right here.\n\nЗаказ %ID% отменён. Если это неожиданно — напишите мне прямо здесь.",
};

export default async function handler(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  if (!hasKV()) {
    res.status(500).json({ ok: false, error: "kv_not_configured" });
    return;
  }
  try {
    if (req.method === "GET") {
      const ids = (await kv(["ZRANGE", "orders", "-100", "-1"])) || [];
      let orders = [];
      if (ids.length) {
        const raws = await kv(["MGET", ...ids.map((i) => "order:" + i)]);
        orders = raws.filter(Boolean).map((r) => JSON.parse(r)).reverse();
      }
      res.status(200).json({ ok: true, orders });
      return;
    }
    if (req.method === "POST") {
      const { id, status } = req.body || {};
      if (typeof id !== "string" || !ORDER_RE.test(id) || !STATUSES.includes(status)) {
        res.status(400).json({ ok: false, error: "bad_request" });
        return;
      }
      const raw = await kv(["GET", "order:" + id]);
      if (!raw) { res.status(404).json({ ok: false, error: "not_found" }); return; }
      const order = JSON.parse(raw);
      order.status = status;
      order.updatedAt = Date.now();
      await kv(["SET", "order:" + id, JSON.stringify(order)]);
      let notified = false;
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (order.chatId && token && CUSTOMER_MSG[status]) {
        try {
          const j = await tgSend(token, order.chatId, CUSTOMER_MSG[status].replaceAll("%ID%", id));
          notified = j.ok === true;
        } catch (e) { /* notification is best-effort */ }
      }
      res.status(200).json({ ok: true, notified });
      return;
    }
    res.status(405).json({ ok: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: "kv_error" });
  }
}
