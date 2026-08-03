// api/validate-promo-code.js
// 2026-08 신규: Pago 페이지에서 할인코드 실시간 검증용
// 고객이 코드를 입력하면 이 API를 호출해서 "유효한가 + 몇 % 할인인가"를 확인한다.
// 실제 결제 시 할인 적용은 create-checkout-session.js에서 별도로 다시 검증 후 처리한다
// (프론트에서 조작된 % 값을 그대로 믿지 않기 위함).

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const RAW_ALLOWED = process.env.CORS_ALLOWED_ORIGINS || [
    "https://ofinova-madrid.es", "https://www.ofinova-madrid.es", "https://*.framer.app", "https://ofinova.vercel.app", "http://localhost:3000",
].join(",");

const ALLOWED = RAW_ALLOWED.split(",").map((s) => s.trim()).filter(Boolean);

function matchWildcard(pattern, origin) {
  if (!pattern.includes("*")) return pattern === origin;
  try {
    const u = new URL(origin);
    const hostPattern = pattern.split("://")[1];
    const re = new RegExp("^" + hostPattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    const patternProto = pattern.split("://")[0];
    return u.protocol.replace(":", "") === patternProto && re.test(u.host);
  } catch { return false; }
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED.some((pat) => matchWildcard(pat, origin));
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin(origin) ? origin : "https://ofinova-madrid.es");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { code } = req.body || {};
    const cleanCode = String(code || "").trim().toUpperCase();

    if (!cleanCode) {
      return res.status(400).json({ valid: false, error: "Código vacío" });
    }

    // Stripe는 promotion code를 "code" 파라미터로 정확히 일치 검색한다 (대소문자 구분함)
    const list = await stripe.promotionCodes.list({
      code: cleanCode,
      active: true,
      limit: 1,
    });

    const promo = list.data[0];

    if (!promo) {
      return res.status(200).json({ valid: false, error: "Código no válido o caducado" });
    }

    // 쿠폰 자체도 유효한지 확인 (예: max redemptions 초과, archived 등)
    const coupon = promo.coupon;
    if (!coupon || coupon.valid === false) {
      return res.status(200).json({ valid: false, error: "Código no válido o caducado" });
    }

    // 최대 사용 횟수 초과 여부 (Stripe가 active=true로 자동 걸러주지만 이중 확인)
    if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) {
      return res.status(200).json({ valid: false, error: "Este código ha alcanzado su límite de usos" });
    }

    return res.status(200).json({
      valid: true,
      code: cleanCode,
      promotion_code_id: promo.id,
      percent_off: coupon.percent_off || 0,
      duration: coupon.duration, // "forever" | "once" | "repeating"
    });
  } catch (err) {
    console.error("[validate-promo-code] error:", err);
    return res.status(500).json({ valid: false, error: "Error al validar el código" });
  }
}
