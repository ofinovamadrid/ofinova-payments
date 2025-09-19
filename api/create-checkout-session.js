import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/**
 * 본체 플랜 — 순액(IVA 제외) 금액, 센트 단위
 */
const PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  }, // 69.00€
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 }, // 120.00€
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, // 204.00€
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 }, // 336.00€
};

/**
 * 플랜ID → 개월 수 (백엔드 신뢰 소스)
 */
const PLAN_MONTHS = {
  p3:  3,
  p6:  6,
  p12: 12,
  p24: 24,
};

/**
 * 우편 요금표 — 월요금, 순액(IVA 제외), 센트 단위
 * (프런트 값은 신뢰하지 않고 서버 표를 사용)
 */
const MAIL_PRICE_TABLE = {
  lite: 390, // 3.90€/mes
  pro:  990, // 9.90€/mes
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

// 안전한 정수 파서
function toInt(v, def = 0) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : def;
}

// 안전한 불리언 파서 ("1"/"true"/true → true)
function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
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

    // ✅ lead_id/orderId 정규화(하나로 통일)
    const leadId = String(
      metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? ""
    ).trim();

    // 런칭 안정성 위해 키 누락은 세션 생성 중단(데이터 고아 방지)
    if (!leadId) {
      return res.status(400).json({ error: "Missing lead_id/orderId in metadata" });
    }

    // ─────────────────────────────────────────────────────────────
    // 1) 메일 옵션 재계산 (서버 신뢰 소스)
    //    - mailEnabled: "1"/"true"면 활성
    //    - mailPlan: "lite"|"pro" 중 유효할 때만 추가
    //    - months: metadata.months 없으면 planId로 보정
    //    - mailCharge: "upfront-all" → 개월 수만큼, "monthly-only" → 1개월만
    // ─────────────────────────────────────────────────────────────
    const monthsRaw = toInt(metadata.months, PLAN_MONTHS[planId] || 0);
    const months = Math.max(1, monthsRaw); // 최소 1개월 보정

    const mailEnabled = toBool(metadata.mailEnabled);
    const mailPlan = String(metadata.mail ?? "").trim().toLowerCase(); // lite|pro|none
    const mailCharge = String(metadata.mailCharge ?? "").trim().toLowerCase(); // upfront-all|monthly-only
    const mailMonthlyCents = MAIL_PRICE_TABLE[mailPlan]; // undefined면 미적용

    // 본체 라인아이템 (A)
    const line_items = [
      {
        price_data: {
          currency: "eur",
          product_data: { name: baseItem.name },
          unit_amount: baseItem.unit_amount, // net (sin IVA)
          tax_behavior: "exclusive",         // IVA 별도
        },
        quantity: 1,
      },
    ];

    // 우편 라인아이템 (B) — 조건부 추가
    if (mailEnabled && mailMonthlyCents && months > 0) {
      const qty = mailCharge === "upfront-all" ? months : 1;
      const titleSuffix =
        mailCharge === "upfront-all" ? ` · ${months} meses` : " · 1ª mensualidad";
      const mailName =
        `Gestión de correo — ${mailPlan === "lite" ? "Mail Lite" : "Mail Pro"}${titleSuffix}`;

      line_items.push({
        price_data: {
          currency: "eur",
          product_data: { name: mailName },
          unit_amount: mailMonthlyCents, // net (sin IVA)
          tax_behavior: "exclusive",
        },
        quantity: qty,
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 2) Stripe Checkout 세션 생성
    // ─────────────────────────────────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      // ✅ Stripe가 IVA 자동 계산/추가
      automatic_tax: { enabled: true },

      // ✅ 세금 계산 위해 청구지 주소 필수
      billing_address_collection: "required",

      // 결제 항목(순액, 세금 별도)
      line_items,

      // 고객 이메일: 있으면 전달(선택)
      customer_email: email || undefined,

      // 프런트 복귀 URL
      success_url: `${baseUrl}/pago?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pago?status=failed&canceled=1`,

      // ✅ 메타데이터(세션/PI 모두 저장)
      //    - ...metadata 먼저 → 우리 표준 키(lead_id/orderId/planId)로 최종 덮어쓰기
      metadata: stringifyMeta({ ...metadata, lead_id: leadId, orderId: leadId, planId }),
      payment_intent_data: {
        metadata: stringifyMeta({ ...metadata, lead_id: leadId, orderId: leadId, planId }),
      },

      // ✅ 성공 웹훅 매칭용(Checkout 전용): 클라-서버 공통 키
      client_reference_id: leadId,

      // 선택: Checkout UI 로케일 자동
      locale: "auto",
    });

    // 디버깅 편의를 위해 키/세션ID도 반환(원하면 제거 가능)
    res.status(200).json({ url: session.url, lead_id: leadId, session_id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
