// api/create-checkout-session.js
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// 총액(cent)
const PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  }, // 69€
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 }, // 120€
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, // 204€
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 }, // 336€
};

// CORS 허용 (프레이머 도메인)
const ALLOWED_ORIGIN =
  process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Stripe metadata 값은 모두 string 이어야 함
function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { planId, email, metadata = {} } = req.body || {};
    if (!planId || !PRICE_TABLE[planId]) {
      return res.status(400).json({ error: "Invalid planId" });
    }

    const item = PRICE_TABLE[planId];
    const baseUrl =
      process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

    // lead_id 추출(클라이언트 metadata 사용)
    const leadId = metadata.lead_id || metadata.leadId || "";

    // 세션/PI에 넣을 메타데이터 준비
    const sessionMetadata = stringifyMeta({ planId, ...metadata });
    if (leadId) sessionMetadata.lead_id = String(leadId);

    const piMetadata = leadId ? stringifyMeta({ lead_id: leadId }) : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      automatic_tax: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: item.name },
            unit_amount: item.unit_amount,
            tax_behavior: "exclusive",
          },
          quantity: 1,
        },
      ],
      customer_email: email || undefined,

      // ★ PAGO 리다이렉트 파라미터(프론트 useEffect가 읽음)
      success_url: `${baseUrl}/pago?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pago?status=failed&canceled=1`,

      // ★ 세션 메타데이터(lead_id 포함 — 값이 있을 때만)
      metadata: sessionMetadata,

      // ★ PaymentIntent 메타데이터에도 lead_id 넣음(웹훅 매칭용)
      ...(piMetadata
        ? { payment_intent_data: { metadata: piMetadata } }
        : {}), // lead_id 없으면 생략
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
