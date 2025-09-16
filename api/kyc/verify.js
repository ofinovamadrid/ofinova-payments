// /api/kyc/verify.js  (Vercel Serverless Function, JS 버전)
export default async function handler(req, res) {
  // CORS — 지금은 개발 편의상 모두 허용(추후 특정 도메인으로 제한 권장)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = String(req.query.token || "");
  if (!token) {
    return res.status(400).json({ ok: false, reason: "missing-token" });
  }

  // TODO: 나중에 실제 결제/주문 레코드로 검증
  const isValid = token === "TEST";

  if (!isValid) {
    return res.status(401).json({ ok: false, reason: "invalid-token" });
  }

  // 데모용 프리필 데이터(추후 DB 조회 결과로 교체)
  return res.status(200).json({
    ok: true,
    orderId: "demo-123",
    email: "demo@ofinova.es",
    name: "Demo Client",
  });
}
