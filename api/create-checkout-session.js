// api/create-checkout-session.js
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// 총액(cent)
const PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  },
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 },
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 },
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 },
};

// CORS 허용
const ALLOWED_ORIGIN = process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Stripe 메타데이터는 모두 string
function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, metadata = {} } = req.body || {};
    if (!planId || !PRICE_TABLE[planId]) return res.status(400).json({ error: "Invalid planId" });

    const item = PRICE_TABLE[planId];
    const baseUrl = process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

    // lead_id 추출
    const leadId = metadata.lead_id || metadata.leadId || "";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      automatic_tax: { enabled: true },

      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: item.name },
          unit_amount: item.unit_amount,
          tax_behavior: "exclusive",
        },
        quantity: 1,
      }],

      customer_email: email || undefined,

      // 프론트로 돌아오는 URL
      success_url: `${baseUrl}/pago?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/pago?status=failed&canceled=1`,

      // ★ 세션/PI에 동일 lead_id 저장
      metadata: stringifyMeta({ lead_id: leadId, planId, ...metadata }),
      payment_intent_data: { metadata: stringifyMeta({ lead_id: leadId }) },

      // ★ 참고용: 세션 레벨 식별자에도 넣어두면 대시보드에서 바로 보임
      client_reference_id: leadId || undefined,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
