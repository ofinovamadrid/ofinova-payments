// api/create-checkout-session.js
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// 순액(IVA 제외) 총액을 센트로 정의
const PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  }, // 69.00€
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 }, // 120.00€
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, // 204.00€
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 }, // 336.00€
};

// CORS (프레이머 도메인으로 교체 가능)
const ALLOWED_ORIGIN =
  process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Stripe 메타데이터는 문자열만 허용
function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, metadata = {} } = req.body || {};
    if (!planId || !PRICE_TABLE[planId]) {
      return res.status(400).json({ error: "Invalid planId" });
    }

    const item = PRICE_TABLE[planId];
    const baseUrl =
      process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

    // lead_id 추출(있을 때만 전달)
    const leadId = metadata.lead_id || metadata.leadId || "";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      // ✅ Stripe가 IVA를 자동으로 계산/추가
      automatic_tax: { enabled: true },

      // ✅ 세금 계산을 위해 청구지 주소는 필수로 받기
      billing_address_collection: "required",

      // 결제 항목(순액, 세금 별도)
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: item.name },
            unit_amount: item.unit_amount, // net price (sin IVA)
            tax_behavior: "exclusive",     // IVA 별도 부과
          },
          quantity: 1,
        },
      ],

      // 고객 이메일: 있으면 전달(선택)
      customer_email: email || undefined,

      // 프런트 복귀 URL
      success_url: `${baseUrl}/pago?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pago?status=failed&canceled=1`,

      // 메타데이터(세션/PI 모두 저장)
      metadata: stringifyMeta({ lead_id: leadId, planId, ...metadata }),
      payment_intent_data: { metadata: stringifyMeta({ lead_id: leadId }) },

      // 대시보드 식별 편의용
      client_reference_id: leadId || undefined,

      // 선택: Checkout UI 로케일 자동
      locale: "auto",
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
