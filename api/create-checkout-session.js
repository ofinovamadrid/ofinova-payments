import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/** 본체 플랜 — 순액(IVA 제외) 금액, 센트 단위 */
const PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  }, // 69.00€
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 }, // 120.00€
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, // 204.00€
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 }, // 336.00€
};

/** 플랜ID → 개월 수 (백엔드 신뢰 소스) */
const PLAN_MONTHS = { p3: 3, p6: 6, p12: 12, p24: 24 };

/** 우편 월요금 — 순액(IVA 제외), 센트 단위 */
const MAIL_PRICE_TABLE = { lite: 390, pro: 990 };

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

function toInt(v, def = 0) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : def;
}
function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function normPlan(s) {
  const t = String(s ?? "").toLowerCase().replace(/\s+/g, "");
  if (t.includes("lite")) return "lite";
  if (t.includes("pro")) return "pro";
  if (t === "lite" || t === "pro") return t;
  return ""; // unknown
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

    const baseItem = PRICE_TABLE[planId];
    const baseUrl =
      process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

    // lead_id(orderId) 정규화
    const leadId = String(
      metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? ""
    ).trim();
    if (!leadId) {
      return res.status(400).json({ error: "Missing lead_id/orderId in metadata" });
    }

    // ─────────────────────────────────────────
    // 1) 메일 옵션 재계산(서버 기준) + 강한 폴백
    // ─────────────────────────────────────────
    const months =
      toInt(metadata.months, PLAN_MONTHS[planId] || 0) || PLAN_MONTHS[planId];

    // 다양한 키 허용
    const mailEnabled =
      toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;

    const mailPlanRaw =
      metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? "";
    const mailPlan = normPlan(mailPlanRaw); // "" | "lite" | "pro"

    const mailCharge =
      String(metadata.mailCharge ?? metadata.mail_charge ?? "").toLowerCase() ||
      "upfront-all"; // 기본값

    // 클라 전달 월요금(폴백용) — 믿지는 않지만 인식 실패시만 사용
    const clientMailMonthly = Math.max(0, Number(String(metadata.mailMonthly ?? "").replace(",", "."))) || 0;

    // 본체(A)
    const line_items = [
      {
        price_data: {
          currency: "eur",
          product_data: { name: baseItem.name },
          unit_amount: baseItem.unit_amount, // net (sin IVA)
          tax_behavior: "exclusive",
        },
        quantity: 1,
      },
    ];

    // 우편(B) — 조건부
    let dbg_mail_applied = "0";
    let dbg_mail_qty = "0";
    let dbg_mail_unit = "0";
    let dbg_mail_reason = "";

    if (mailEnabled) {
      // 1순위: 서버 요금표가 인식된 경우
      let unit = MAIL_PRICE_TABLE[mailPlan];
      let planLabel =
        mailPlan === "lite" ? "Mail Lite" : mailPlan === "pro" ? "Mail Pro" : "";

      // 2순위 폴백: 클라가 보낸 월요금이 0 초과면 custom 라인 추가
      if (!unit && clientMailMonthly > 0) {
        unit = Math.round(clientMailMonthly * 100); // € → cents
        planLabel = "Mail (custom)";
        dbg_mail_reason = "fallback_from_client_mailMonthly";
      } else if (unit) {
        dbg_mail_reason = "server_price_table";
      }

      if (unit && months > 0) {
        const qty = mailCharge === "monthly-only" ? 1 : months;
        const titleSuffix = mailCharge === "monthly-only" ? " · 1ª mensualidad" : ` · ${months} meses`;
        const name = `Gestión de correo — ${planLabel}${titleSuffix}`;

        line_items.push({
          price_data: {
            currency: "eur",
            product_data: { name },
            unit_amount: unit, // net (sin IVA)
            tax_behavior: "exclusive",
          },
          quantity: qty,
        });

        dbg_mail_applied = "1";
        dbg_mail_qty = String(qty);
        dbg_mail_unit = String(unit);
      } else if (!dbg_mail_reason) {
        dbg_mail_reason = "mail_not_added_conditions_failed";
      }
    } else {
      dbg_mail_reason = "mail_disabled";
    }

    // ─────────────────────────────────────────
    // 2) Stripe Checkout 세션 생성
    // ─────────────────────────────────────────
    const sessMeta = {
      ...metadata,
      lead_id: leadId,
      orderId: leadId,
      planId,
      // 디버그 플래그(Stripe 대시보드 세션/PI에서 바로 확인)
      dbg_mail_applied,
      dbg_mail_qty,
      dbg_mail_unit,
      dbg_mail_reason,
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      automatic_tax: { enabled: true },
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

    res.status(200).json({ url: session.url, lead_id: leadId, session_id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
