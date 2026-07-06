// Vercel serverless function: Telegram bot webhook.
// Set as webhook once (in your browser, with your token):
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://puerhbar.com/api/telegram&secret_token=<YOUR_SECRET>
// Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (your admin chat),
//           TELEGRAM_WEBHOOK_SECRET (same value as secret_token above)
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
  if (req.method !== "POST") { res.status(405).end(); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const admin = process.env.TELEGRAM_CHAT_ID;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !admin) { res.status(500).json({ ok: false }); return; }
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    res.status(401).end(); return;
  }
  const send = (chat_id, text) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text }),
    });

  const msg = req.body && req.body.message;
  if (!msg || !msg.text) { res.status(200).json({ ok: true }); return; }
  const chatId = msg.chat.id;
  const uname = msg.from.username ? "@" + msg.from.username : (msg.from.first_name || "customer");
  const text = msg.text.trim();

  try {
    if (String(chatId) === String(admin)) {
      // Admin command: /reply <chat_id> <message>
      const m = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
      if (m) { await send(m[1], m[2]); await send(admin, "✅ Sent."); }
      else if (text.startsWith("/")) { await send(admin, "Command: /reply <chat_id> <message>"); }
    } else if (text.startsWith("/start") && text.split(" ")[1] === "help") {
      await send(chatId, "👋 Ask your question right here — about flavours, custom orders, delivery, anything. I'll reply soon.\n\nЗадайте вопрос прямо здесь — про вкусы, кастомные заказы, доставку, что угодно. Я скоро отвечу.");
      await send(admin, `❓ ${uname} (${chatId}) opened the help chat.\nReply: /reply ${chatId} <message>`);
    } else if (text.startsWith("/start")) {
      const orderId = text.split(" ")[1];
      // link this chat to the order so status updates reach the customer
      if (orderId && /^TICE-[A-Z0-9]{4,12}$/.test(orderId)) {
        try {
          const raw = await kv(["GET", "order:" + orderId]);
          if (raw) {
            const order = JSON.parse(raw);
            order.chatId = chatId;
            await kv(["SET", "order:" + orderId, JSON.stringify(order)]);
          }
        } catch (e) { /* tracking is optional */ }
      }
      await send(chatId, orderId
        ? `🍦 Order ${orderId} received! Ivan will confirm your delivery time here soon.\n\nЗаказ ${orderId} получен! Иван скоро подтвердит здесь время доставки.`
        : `🍦 Welcome to TICE! Order at puerhbar.com/icecream — confirmations arrive here.\n\nДобро пожаловать в TICE! Заказывайте на puerhbar.com/icecream — подтверждения приходят сюда.`);
      await send(admin, `🔔 ${uname} connected${orderId ? ` for order ${orderId}` : ""}.\nReply with: /reply ${chatId} <message>`);
    } else {
      await send(admin, `💬 ${uname} (${chatId}):\n${text}\n\nReply: /reply ${chatId} <message>`);
      await send(chatId, "Got it! Ivan will reply here soon.\nПринято! Иван скоро ответит здесь.");
    }
  } catch (e) { /* never fail the webhook */ }
  res.status(200).json({ ok: true });
}
