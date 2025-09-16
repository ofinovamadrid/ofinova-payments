// /api/kyc/sign-upload.js
import { createClient } from "@supabase/supabase-js";
import { json } from "micro";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png"];
const MAX = 25 * 1024 * 1024; // 25MB

function extFromMime(m) {
  if (m === "application/pdf") return "pdf";
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png") return "png";
  return "bin";
}

// ✅ 검증 서버 주소를 확실히 지정(환경변수 없으면 고정 도메인)
const VERIFY_BASE =
  process.env.KYC_VERIFY_BASE || "https://ofinova-payments.vercel.app";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, reason: "method-not-allowed" });

  let body;
  try {
    body = await json(req);
  } catch {
    return res.status(400).json({ ok: false, reason: "bad-json" });
  }

  const { token, kind = "id", mime, size } = body || {};
  if (!token) return res.status(400).json({ ok: false, reason: "missing-token" });
  if (!mime || typeof size !== "number")
    return res.status(400).json({ ok: false, reason: "missing-file-meta" });
  if (!ALLOWED.includes(mime))
    return res.status(415).json({ ok: false, reason: "unsupported-type", allowed: ALLOWED });
  if (size > MAX)
    return res.status(413).json({ ok: false, reason: "file-too-large", max: MAX });

  // 1) 토큰 검증 → orderId 얻기
  let orderId = null;
  try {
    const r = await fetch(`${VERIFY_BASE}/api/kyc/verify?token=${encodeURIComponent(token)}`);
    if (r.ok) {
      const data = await r.json();
      if (data?.ok) orderId = data.orderId;
    }
  } catch {
    // ignore
  }
  if (!orderId) return res.status(401).json({ ok: false, reason: "invalid-token" });

  // 2) 업로드 경로
  const ext = extFromMime(mime);
  const safeKind = ["id", "company"].includes(kind) ? kind : "id";
  const ts = Date.now();
  const path = `orders/${orderId}/KYC_${orderId}_${safeKind}_${ts}.${ext}`;

  // 3) Supabase 서명 업로드 URL 발급
  const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
  const bucket = process.env.KYC_BUCKET || "kyc";

  const { data, error } = await supa.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data?.token) {
    return res.status(500).json({ ok: false, reason: "sign-url-failed", detail: error?.message });
  }

  return res.status(200).json({
    ok: true,
    bucket,
    path,
    uploadToken: data.token,
    max: MAX,
    allowed: ALLOWED,
  });
}
