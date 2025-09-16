// /api/kyc/sign-upload.js
// Vercel Serverless: 서명 업로드 URL 발급
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

export default async function handler(req, res) {
  // CORS (MVP: 전부 허용, 추후 프레이머/커스텀 도메인으로 제한 권장)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, reason: "method-not-allowed" });

  // JSON 바디 파싱
  let body;
  try {
    body = await json(req);
  } catch (e) {
    return res.status(400).json({ ok: false, reason: "bad-json" });
  }

  const { token, kind = "id", mime, size } = body || {};
  if (!token) return res.status(400).json({ ok: false, reason: "missing-token" });
  if (!mime || typeof size !== "number")
    return res
      .status(400)
      .json({ ok: false, reason: "missing-file-meta" });
  if (!ALLOWED.includes(mime))
    return res
      .status(415)
      .json({ ok: false, reason: "unsupported-type", allowed: ALLOWED });
  if (size > MAX)
    return res
      .status(413)
      .json({ ok: false, reason: "file-too-large", max: MAX });

  // 1) 토큰 검증 → orderId 얻기
  const base =
    process.env.VERCEL_URL?.startsWith("http")
      ? process.env.VERCEL_URL
      : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

  let orderId = null;
  try {
    const r = await fetch(
      `${base}/api/kyc/verify?token=${encodeURIComponent(token)}`
    );
    if (r.ok) {
      const data = await r.json();
      if (data?.ok) orderId = data.orderId;
    }
  } catch (e) {
    // noop
  }
  if (!orderId) return res.status(401).json({ ok: false, reason: "invalid-token" });

  // 2) 업로드 경로 생성
  const ext = extFromMime(mime);
  const safeKind = ["id", "company"].includes(kind) ? kind : "id";
  const ts = Date.now();
  const path = `orders/${orderId}/KYC_${orderId}_${safeKind}_${ts}.${ext}`;

  // 3) Supabase 서명 업로드 URL 발급
  const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE
  );
  const bucket = process.env.KYC_BUCKET || "kyc";

  const { data, error } = await supa.storage
    .from(bucket)
    .createSignedUploadUrl(path); // 반환: data.token (업로드 토큰)

  if (error || !data?.token) {
    return res
      .status(500)
      .json({ ok: false, reason: "sign-url-failed", detail: error?.message });
  }

  // 응답: 프런트는 data.token으로 실제 업로드를 수행함
  return res.status(200).json({
    ok: true,
    bucket,
    path,
    uploadToken: data.token,
    max: MAX,
    allowed: ALLOWED,
  });
}
