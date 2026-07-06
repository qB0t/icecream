// Auth: email/password + Google sign-in. Issues HMAC-signed session tokens.
// Env vars: AUTH_SECRET (required, any long random string), GOOGLE_CLIENT_ID (optional),
//           KV_REST_API_URL/TOKEN.
// GET  /api/auth -> { ok, google: <client id or null> }  (config for the site)
// POST /api/auth { mode:"register"|"login", email, password }  -> { ok, token, email }
// POST /api/auth { mode:"google", credential }                 -> { ok, token, email }
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
function sign(email) {
  const p = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 180 * 864e5 })).toString("base64url");
  const s = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(p).digest("base64url");
  return p + "." + s;
}
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      google: process.env.GOOGLE_CLIENT_ID || null,
      bot: process.env.TELEGRAM_BOT_USERNAME || null,
    });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }
  if (!process.env.AUTH_SECRET || !KV_URL || !KV_TOKEN) {
    res.status(500).json({ ok: false, error: "not_configured" });
    return;
  }
  const { mode } = req.body || {};
  try {
    if (mode === "register" || mode === "login") {
      const email = normEmail(req.body.email);
      const password = String(req.body.password || "");
      if (!validEmail(email)) { res.status(400).json({ ok: false, error: "bad_email" }); return; }
      if (password.length < 8) { res.status(400).json({ ok: false, error: "short_password" }); return; }
      const raw = await kv(["GET", "user:" + email]);
      if (mode === "register") {
        if (raw) { res.status(409).json({ ok: false, error: "exists" }); return; }
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = crypto.scryptSync(password, salt, 64).toString("hex");
        await kv(["SET", "user:" + email, JSON.stringify({ email, pw: { salt, hash }, createdAt: Date.now() })]);
        res.status(200).json({ ok: true, token: sign(email), email });
        return;
      }
      // login
      if (!raw) { res.status(401).json({ ok: false, error: "wrong_credentials" }); return; }
      const user = JSON.parse(raw);
      if (!user.pw) { res.status(401).json({ ok: false, error: "google_account" }); return; }
      const hash = crypto.scryptSync(password, user.pw.salt, 64).toString("hex");
      const a = Buffer.from(hash), b = Buffer.from(user.pw.hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ ok: false, error: "wrong_credentials" });
        return;
      }
      res.status(200).json({ ok: true, token: sign(email), email });
      return;
    }
    if (mode === "google") {
      const cid = process.env.GOOGLE_CLIENT_ID;
      if (!cid) { res.status(400).json({ ok: false, error: "google_disabled" }); return; }
      const cred = String(req.body.credential || "");
      const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cred));
      if (!r.ok) { res.status(401).json({ ok: false, error: "google_invalid" }); return; }
      const info = await r.json();
      if (info.aud !== cid || info.email_verified !== "true" || !validEmail(info.email)) {
        res.status(401).json({ ok: false, error: "google_invalid" });
        return;
      }
      const email = normEmail(info.email);
      const raw = await kv(["GET", "user:" + email]);
      if (!raw) {
        await kv(["SET", "user:" + email, JSON.stringify({ email, google: true, name: info.name || "", createdAt: Date.now() })]);
      }
      res.status(200).json({ ok: true, token: sign(email), email });
      return;
    }
    res.status(400).json({ ok: false, error: "bad_mode" });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
}
