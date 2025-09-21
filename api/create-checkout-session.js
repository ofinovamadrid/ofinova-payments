// api/create-checkout-session.js
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/** IVA 21% 세율 — 대시보드 Tax rates의 ID.
 *  환경변수 STRIPE_TAX_RATE_ID 가 있으면 그걸 쓰고,
 *  없으면 현재 사용하던 고정값을 fallback으로 사용. */
const TAX_RATE_ID =
  process.env.STRIPE_TAX_RATE_ID || "txr_1S9RT93pToW48VXP6fB9vkUy";

/** 랜딩의 '계약기간' 키 → 개월수 */
const PLAN_MONTHS = { p3: 3, p6: 6, p12: 12, p24: 24 };

/** 주소지(도미실리오) 월 요금용 Stripe Price IDs (구독 전용)
 *  계약기간에 따라 월요금이 달라지므로,
 *  p3→23€/mo, p6→20€/mo, p12→17€/mo, p24→14€/mo 로 매핑한다. */
const PRICE_DOMI_BY_PLAN = {
  p3: process.env.STRIPE_PRICE_DOMI_23, // 23€/mo
  p6: process.env.STRIPE_PRICE_DOMI_20, // 20€/mo
  p12: process.env.STRIPE_PRICE_DOMI_17, // 17€/mo
  p24: process.env.STRIPE_PRICE_DOMI_14, // 14€/mo
};

/** 우편물(구독) 월 요금 Price IDs */
const PRICE_MAIL = {
  lite: process.env.STRIPE_PRICE_MAIL_LITE_390, // 3.90€/mo
  pro: process.env.STRIPE_PRICE_MAIL_PRO_990,   // 9.90€/mo
};

/** 일시불 결제(한번에 전액)용 순액(IVA 제외) 금액 표 — 센트 단위 */
const UPFRONT_PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  }, // 69.00€
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 }, // 120.00€
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, // 204.00€
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 }, // 336.00€
};

/** 우편(일시불에서 월×개월 계산에 쓰는 순액, 센트) */
const MAIL_NET_EUR_CENTS = { lite: 390, pro: 990 };

/** CORS 허용 출처 (프레이머 도메인) */
const ALLOWED_ORIGIN =
  process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}
const toInt = (v, d = 0) =>
  Number.isFinite(parseInt(String(v ?? "").trim(), 10))
    ? parseInt(String(v ?? "").trim(), 10)
    : d;
const toBool = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());
function normMailPlan(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("lite")) return "lite";
  if (t.includes("pro")) return "pro";
  if (t === "lite" || t === "pro") return t;
  return "";
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    /** 필수 입력 */
    const { planId, email, payMode, metadata = {} } = req.body || {};
    if (!planId || !UPFRONT_PRICE_TABLE[planId]) {
      return res.status(400).json({ error: "Invalid planId" });
    }

    /** 공통 값 */
    const baseUrl =
      process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";
    const months = toInt(metadata.months, PLAN_MONTHS[planId]) || PLAN_MONTHS[planId];

    const leadId = String(
      metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? ""
    ).trim();
    if (!leadId) {
      return res.status(400).json({ error: "Missing lead_id/orderId in metadata" });
    }

    /** 우편 옵션 파싱 */
    const mailEnabled =
      toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;
    const mailPlan = normMailPlan(
      metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? ""
    );

    /** 디버그 태그(대시보드에서 확인 편의) */
    const sessMeta = {
      ...metadata,
      lead_id: leadId,
      orderId: leadId,
      planId,
      months,
      mailEnabled: String(mailEnabled ? 1 : 0),
      mailPlan: mailPlan || "",
      mode: (payMode || metadata.payMode || "payment").toLowerCase(), // "payment" | "subscription"
    };

    /** ─────────────────────────────────────────
     *  A) 구독(매월 자동이체) — Stripe Price IDs 사용
     *  요청 바디의 payMode === "subscription" 이면 이 경로로
     *  ───────────────────────────────────────── */
    if ((payMode || metadata.payMode || "").toLowerCase() === "subscription") {
      const domiPriceId = PRICE_DOMI_BY_PLAN[planId];
      if (!domiPriceId) {
        return res.status(400).json({
          error: `Missing monthly Price ID for planId=${planId}. Check Vercel env (STRIPE_PRICE_DOMI_14/17/20/23).`,
        });
      }

      const line_items = [{ price: domiPriceId, quantity: 1 }];
      if (mailEnabled) {
        const mailPriceId = PRICE_MAIL[mailPlan];
        if (!mailPriceId) {
          return res.status(400).json({
            error:
              "Mail plan enabled but no valid plan (lite/pro) or missing env Price ID.",
          });
        }
        line_items.push({ price: mailPriceId, quantity: 1 });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        billing_address_collection: "required",
        line_items,
        // 수동 세율 고정 적용(각 Price에 tax rate를 붙여두지 않았다면 이 방식이 간단)
        subscription_data: TAX_RATE_ID
          ? { default_tax_rates: [TAX_RATE_ID], metadata: stringifyMeta(sessMeta) }
          : { metadata: stringifyMeta(sessMeta) },
        success_url: `${baseUrl}/pago?status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/pago?status=failed&canceled=1`,
        metadata: stringifyMeta(sessMeta), // 세션/PI에도 메타 남김
        customer_email: email || undefined,
        client_reference_id: leadId,
        locale: "auto",
      });

      return res.status(200).json({
        url: session.url,
        lead_id: leadId,
        session_id: session.id,
        mode: "subscription",
      });
    }

    /** ─────────────────────────────────────────
     *  B) 일시불(전액 선결제) — 기존 로직 유지
     *  ───────────────────────────────────────── */
    const baseItem = UPFRONT_PRICE_TABLE[planId];

    const line_items = [
      {
        price_data: {
          currency: "eur",
          product_data: { name: baseItem.name },
          unit_amount: baseItem.unit_amount, // net (sin IVA)
          tax_behavior: "exclusive",
        },
        quantity: 1,
        tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
      },
    ];

    if (mailEnabled && mailPlan) {
      const unit = MAIL_NET_EUR_CENTS[mailPlan]; // net €/mo → cents
      if (unit) {
        line_items.push({
          price_data: {
            currency: "eur",
            product_data: {
              name: `Gestión de correo — ${
                mailPlan === "lite" ? "Mail Lite" : "Mail Pro"
              } · ${months} meses`,
            },
            unit_amount: unit, // net (sin IVA)
            tax_behavior: "exclusive",
          },
          quantity: months, // 월요금 × 개월
          tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      automatic_tax: { enabled: false }, // 수동세율 사용
      billing_address_collection: "required",
      line_items,
      customer_email: email || undefined,
      success_url: `${baseUrl}/pago?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pago?status=failed&canceled=1`,
      metadata: stringifyMeta(sessMeta),
      payment_intent_data: { metadata: stringifyMeta(sessMeta) },
      client_reference_id: leadId,
      locale: "auto",
    });

    return res
      .status(200)
      .json({ url: session.url, lead_id: leadId, session_id: session.id, mode: "payment" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
