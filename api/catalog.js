// Catalog (menu) storage.
// GET  /api/catalog                     -> public: { ok, signature, flavours } (visible items only; nulls if nothing stored)
// GET  /api/catalog + x-admin-key      -> full arrays including hidden items
// POST /api/catalog + x-admin-key      -> { signature:[...], flavours:[...] } saves both arrays
import { kv, hasKV } from "./_lib.js";

function validList(a) {
  return Array.isArray(a) && a.length <= 100 &&
    a.every((x) => x && typeof x.id === "string" && x.id.length <= 40 && typeof x.en === "string") &&
    JSON.stringify(a).length <= 200000;
}

export default async function handler(req, res) {
  const isAdmin = process.env.ADMIN_KEY && req.headers["x-admin-key"] === process.env.ADMIN_KEY;
  try {
    if (req.method === "GET") {
      if (!hasKV()) { res.status(200).json({ ok: true, signature: null, flavours: null }); return; }
      const [sigRaw, flavRaw] = await kv(["MGET", "catalog:signature", "catalog:flavours"]) || [null, null];
      let signature = sigRaw ? JSON.parse(sigRaw) : null;
      let flavours = flavRaw ? JSON.parse(flavRaw) : null;
      if (!isAdmin) {
        if (signature) signature = signature.filter((x) => x.visible !== false);
        if (flavours) flavours = flavours.filter((x) => x.visible !== false);
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, signature, flavours });
      return;
    }
    if (req.method === "POST") {
      if (!isAdmin) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
      if (!hasKV()) { res.status(500).json({ ok: false, error: "kv_not_configured" }); return; }
      const { signature, flavours } = req.body || {};
      if (!validList(signature) || !validList(flavours)) {
        res.status(400).json({ ok: false, error: "bad_request" });
        return;
      }
      await kv(["SET", "catalog:signature", JSON.stringify(signature)]);
      await kv(["SET", "catalog:flavours", JSON.stringify(flavours)]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ ok: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: "kv_error" });
  }
}
