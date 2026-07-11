// Shared helpers for all API functions. Underscore prefix = not deployed as an endpoint.
import crypto from "node:crypto";

const kvUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const kvToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const hasKV = () => Boolean(kvUrl() && kvToken());

export async function kv(cmd) {
  if (!hasKV()) return null;
  const r = await fetch(kvUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${kvToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export const ORDER_RE = /^TICE-[A-Z0-9]{4,12}$/;

// Returns the email from a valid "Bearer <token>" header, or null.
export function verifyToken(hdr) {
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

// TELEGRAM_API_BASE is only set by the local dev server to point at its mock.
const tgBase = () => process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

export async function tgSend(token, chat_id, text) {
  const r = await fetch(`${tgBase()}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
  return r.json();
}
