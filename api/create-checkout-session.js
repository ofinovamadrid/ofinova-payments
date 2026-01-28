// api/create-checkout-session.js
// 2026-01 수정본: 기존 로직 100% 보존 + 신규 요금제(연 17€/월 25€) 및 신규 환경 변수 적용

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/** IVA 21% — Stripe Tax rate ID (from Dashboard) */
const TAX_RATE_ID =
  process.env.STRIPE_TAX_RATE_ID || "txr_1S9RT93pToW48VXP6fB9vkUy";

/** Landing ‘planId’ → months */
const PLAN_MONTHS = { p3: 3, p6: 6, p12: 12, p24: 24 };

/** [수정] 신규 요금 정책 반영 - Make 리포팅용 단가 */
const MONTHLY_UPFRONT_PRICE_EUR = 17; // 연납 시 월 17€ 기준
const MONTHLY_SUBSCRIPTION_PRICE_EUR = 25; // 월납 시 월 25€ 기준

/** [수정] 신규 환경 변수명으로 매핑 - Subscription 전용 */
const PRICE_DOMI_BY_PLAN = {
  p3: process.env.STRIPE_PRICE_DOMI_MONTHLY, // 월 25€ ID
  p6: process.env.STRIPE_PRICE_DOMI_MONTHLY,
  p12: process.env.STRIPE_PRICE_DOMI_ANNUAL,  // 연 204€ ID
  p24: process.env.STRIPE_PRICE_DOMI_ANNUAL,
};

/** [수정] 신규 우편 서비스 환경 변수 매핑 */
const PRICE_MAIL = {
  monthly: process.env.STRIPE_PRICE_MAIL_MONTHLY, // 월 3.9€
  annual: process.env.STRIPE_PRICE_MAIL_ANNUAL,   // 연 46.8€
};

/**
 * [수정] 일시불(upfront) 금액 테이블 (단위: cents)
 * - p3/p6: 25€ 기준 (75€, 150€)
 * - p12/p24: 17€ 기준 (204€, 408€)
 */
const UPFRONT_PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount:  7500 }, 
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 15000 }, 
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, //
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 40800 }, 
};

/** [수정] 우편 서비스 단가 통합 (단위: cents) */
const MAIL_NET_EUR_CENTS = 390;

/* ───────── Site URL ───────── */
const SITE_URL =
  process.env.SITE_URL ||
  process.env.APP_BASE_URL ||
  "https://ofinova-madrid.es";

const successUrl = `${SITE_URL}/confirmacion?session_id={CHECKOUT_SESSION_ID}&status=success&paid=1`;
const cancelUrl  = `${SITE_URL}/pago?status=cancelled`;

/* ───────── CORS (원본 보존) ───────── */
const RAW_ALLOWED =
  process.env.CORS_ALLOWED_ORIGINS ||
  [
    "https://ofinova-madrid.es",
    "https://www.ofinova-madrid.es",
    "https://*.framer.app",
    "https://ofinova.vercel.app",
    "http://localhost:3000",
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
  } catch {
    return false;
  }
}
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED.some((pat) => matchWildcard(pat, origin));
}
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://ofinova-madrid.es");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ───────── Utils (원본 보존) ───────── */
function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}
const toInt = (v, d = 0) => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : d;
};
const toBool = (v) =>
  ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());

function normMailPlan(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("lite") || t.includes("pro")) return "active"; 
  return "";
}
function normIndustry(s) {
  const t = String(s ?? "").trim();
  return t;
}
const firstNonEmpty = (...vals) => {
  for (const v of vals) {
    const s = typeof v === "string" ? v : (v == null ? "" : String(v));
    if (s && s.trim()) return s.trim();
  }
  return "";
};

/* ───────── Fire-and-forget to Make (원본 보존) ───────── */
const MAKE_CHECKOUT_WEBHOOK_URL = process.env.MAKE_CHECKOUT_WEBHOOK_URL || "";
function postToMake(payload) {
  if (!MAKE_CHECKOUT_WEBHOOK_URL) return;
  try {
    fetch(MAKE_CHECKOUT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(payload) }),
    }).catch(() => {});
  } catch {
    // swallow
  }
}

/* ───────── Handler ───────── */
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, payMode, metadata = {} } = req.body || {};
    if (!planId || !UPFRONT_PRICE_TABLE[planId]) {
      return res.status(400).json({ error: "Invalid planId" });
    }

    const months = toInt(metadata.months, PLAN_MONTHS[planId]) || PLAN_MONTHS[planId];
    const leadId = String(metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? "").trim();
    if (!leadId) {
      return res.status(400).json({ error: "Missing lead_id/orderId in metadata" });
    }

    const companyLegalName = firstNonEmpty(metadata.company_legal_name, metadata.companyLegalName);
    const companyCifNif = firstNonEmpty(metadata.company_cif_nif, metadata.companyCifNif);
    const mailEnabled = toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;
    const mailPlan = normMailPlan(metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? "");
    const wantGestoria = toBool(metadata.want_gestoria) || toBool(metadata.wantGestoria) || false;

    const industry = normIndustry(firstNonEmpty(
        metadata.industry, metadata.sector, metadata.actividad, metadata.actividad_sector, metadata.activity_sector,
        req.body?.industry, req.body?.sector, req.body?.actividad, req.body?.actividad_sector, req.body?.activity_sector
    ));

    const mode = (payMode || metadata.payMode || "payment").toLowerCase();

    // Shipping fallback 로직 (원본 보존)
    const shippingTop = (req.body && typeof req.body.shipping === "object") ? req.body.shipping : undefined;
    let shippingMeta = metadata.shipping;
    if (typeof shippingMeta === "string") { try { shippingMeta = JSON.parse(shippingMeta); } catch { shippingMeta = undefined; } }
    
    const shippingAddress = firstNonEmpty(
      shippingTop?.address, shippingTop?.mail_address, shippingTop?.shipping_address,
      req.body.address, req.body.mail_address, req.body.shipping_address,
      shippingMeta?.address, shippingMeta?.mail_address, shippingMeta?.shipping_address,
      metadata.address, metadata.mail_address, metadata.shipping_address
    );

    const shippingNotes = firstNonEmpty(
      shippingTop?.notes, shippingTop?.mail_address_notes, shippingTop?.shipping_notes,
      req.body.notes, req.body.mail_address_notes, req.body.shipping_notes,
      shippingMeta?.notes, shippingMeta?.mail_address_notes, shippingMeta?.shipping_notes,
      metadata.notes, metadata.mail_address_notes, metadata.shipping_notes
    );

    const sessMeta = {
      ...metadata,
      lead_id: leadId,
      orderId: leadId,
      planId,
      months,
      mailEnabled: String(mailEnabled ? 1 : 0),
      mailPlan: mailPlan || "",
      want_gestoria: String(wantGestoria ? 1 : 0),
      mode,
      company_legal_name: companyLegalName || "",
      company_cif_nif: companyCifNif || "",
      industry: industry || "",
      shipping_address: shippingAddress || "",
      shipping_notes: shippingNotes || "",
    };

    const upfrontConfig = UPFRONT_PRICE_TABLE[planId];
    const totalUpfrontEur = Math.round(upfrontConfig.unit_amount / 100);
    const monthlyPriceEur = mode === "subscription" ? MONTHLY_SUBSCRIPTION_PRICE_EUR : MONTHLY_UPFRONT_PRICE_EUR;
    const totalContractPriceEur = mode === "subscription" ? months * MONTHLY_SUBSCRIPTION_PRICE_EUR : totalUpfrontEur;

    postToMake({
      schema_version: "v1",
      event: "checkout.submit",
      meta: { lead_id: leadId, source: "vercel-api", env: "prod", stage: "payment", pay_mode_choice: mode },
      company: { plan_id: planId, months, price_month: monthlyPriceEur, total_price: totalContractPriceEur },
      options: { mail_enabled: mailEnabled ? 1 : 0, mail_plan: mailPlan || "none", want_gestoria: wantGestoria ? 1 : 0, industry: industry || "" },
      shipping: { address: shippingAddress, notes: shippingNotes },
      company_legal_name: companyLegalName || "",
      company_cif_nif: companyCifNif || "",
      customer_email: email || "",
    });

    /* ───── A) Subscription ───── */
    if (mode === "subscription") {
      const domiPriceId = PRICE_DOMI_BY_PLAN[planId];
      if (!domiPriceId) { return res.status(400).json({ error: "Missing monthly Price ID" }); }
      
      const line_items = [{ price: domiPriceId, quantity: 1 }];
      if (mailEnabled) {
        // [수정] 연납 플랜(p12/p24)이면 연간 우편 ID, 아니면 월간 우편 ID 사용
        const mailPriceId = (planId === 'p12' || planId === 'p24') ? PRICE_MAIL.annual : PRICE_MAIL.monthly;
        line_items.push({ price: mailPriceId, quantity: 1 });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        billing_address_collection: "required",
        line_items,
        subscription_data: TAX_RATE_ID ? { default_tax_rates: [TAX_RATE_ID], metadata: stringifyMeta(sessMeta) } : { metadata: stringifyMeta(sessMeta) },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: stringifyMeta(sessMeta),
        customer_email: email || undefined,
        client_reference_id: leadId,
        locale: "auto",
      });
      return res.status(200).json({ url: session.url, lead_id: leadId, session_id: session.id, mode: "subscription" });
    }

    /* ───── B) One-off (payment) ───── */
    const baseItem = UPFRONT_PRICE_TABLE[planId];
    const line_items = [{
      price_data: {
        currency: "eur",
        product_data: { name: baseItem.name },
        unit_amount: baseItem.unit_amount,
        tax_behavior: "exclusive",
      },
      quantity: 1,
      tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
    }];

    if (mailEnabled) {
      line_items.push({
        price_data: {
          currency: "eur",
          product_data: { name: `Gestión de correo (${months} meses)` },
          unit_amount: MAIL_NET_EUR_CENTS,
          tax_behavior: "exclusive",
        },
        quantity: months,
        tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      automatic_tax: { enabled: false },
      billing_address_collection: "required",
      line_items,
      customer_email: email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: stringifyMeta(sessMeta),
      payment_intent_data: { metadata: stringifyMeta(sessMeta) },
      client_reference_id: leadId,
      locale: "auto",
    });

    return res.status(200).json({ url: session.url, lead_id: leadId, session_id: session.id, mode: "payment" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}
