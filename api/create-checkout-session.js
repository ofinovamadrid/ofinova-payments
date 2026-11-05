// api/create-checkout-session.js
// 2026-08 수정본: 할인코드(Promotion Code) 지원 추가
// - promoCode를 받아 Stripe에서 재검증 후, 유효할 때만 세션에 discounts로 반영
// - 프론트에서 온 percent_off 값은 신뢰하지 않고, 여기서 다시 Stripe API로 확인함
// - 일시불(payment) / 구독(subscription) 두 모드 모두 지원
// - sessMeta에 promo_code 필드 추가 -> Make 웹훅 -> Airtable까지 자동으로 기록됨
//
// 2026-09-15 수정본: 광고 추적(UTM/GCLID) 전달 추가  ★신규★
// - 프론트에서 온 gclid/utm_* 값을 Make 웹훅 payload에 함께 실어 보냄
// - Make -> Airtable Leads_v1 의 gclid / utm_term / utm_source / utm_medium
//   / utm_campaign / utm_content 필드에 매핑하기 위한 것
// - 결제 로직(Stripe 세션 생성)은 단 한 줄도 건드리지 않음 → 기존 결제 흐름 무영향
// - 값이 없으면 빈 문자열로 전송 (기존 동작과 동일하게 안전)
//
// 2026-09-16 수정본: 추적값을 Stripe metadata에도 추가 (B안)  ★신규★
// - sessMeta에 gclid/utm_* 6개를 "값이 있을 때만" 추가
//   → Stripe → Make(Checkout Session Completed) → Airtable Leads_v1
// - Stripe metadata 키 한도(50개)에 닿으면 추가를 생략 → 결제 흐름 절대 안 막힘
//
// 2026-11-05 수정본: 월납(구독) 결제에도 NIF 입력칸 추가  ★신규★
// - 원인: 연납(payment)에는 tax_id_collection이 있었지만 월납(subscription)에는 없어서
//   Checkout 화면에 NIF 칸이 아예 안 떴음 → 첫 factura에 NIF 누락 (예: URNFLWHW-0310)
// - 변경: 구독·일시불 두 세션 모두 tax_id_collection: { enabled: true, required: "if_supported" }
//   → 스페인 등 지원 국가 고객은 NIF를 안 쓰면 결제가 안 넘어감 (Stripe가 형식도 검증)
// - 그 외 결제 로직은 한 줄도 안 건드림. 롤백 = 이 두 줄을 이전 값으로
//
// 2026-11-05 (2차): Pago 페이지에서 NIF를 직접 받는 구조 추가  ★신규★
// - Pago가 billing_nif(DNI/NIE/CIF) + billing_name을 보내면:
//     형식 검사(체크섬) 통과 → Stripe 고객을 먼저 만들고(이름·이메일·NIF) 그 고객으로 결제창을 연다
//     → Stripe 창에 헷갈리는 "Información del IVA" 칸이 안 뜨고, 첫 factura부터 NIF가 박힘
// - billing_nif가 없거나 형식이 틀리면(구버전 Pago, 외국 서류 등) → 이전과 100% 같은 방식
//     (Stripe 창 NIF 필수 + 결제 버튼 옆 안내문 "ES NIF를 고르세요")
// - 고객 미리 만들기가 실패해도 이전 방식으로 자동 전환 → 결제가 절대 막히지 않음
// - 롤백 = 이 파일을 커밋 32af7a6 버전으로

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const TAX_RATE_ID = process.env.STRIPE_TAX_RATE_ID || "txr_1S9RT93pToW48VXP6fB9vkUy";
const PLAN_MONTHS = { p3: 3, p6: 6, p12: 12, p24: 24 };
const MONTHLY_UPFRONT_PRICE_EUR = 17;
const MONTHLY_SUBSCRIPTION_PRICE_EUR = 25;

const PRICE_DOMI_BY_PLAN = {
  p3: process.env.STRIPE_PRICE_DOMI_MONTHLY,
  p6: process.env.STRIPE_PRICE_DOMI_MONTHLY,
  p12: process.env.STRIPE_PRICE_DOMI_ANNUAL,
  p24: process.env.STRIPE_PRICE_DOMI_ANNUAL,
};

const PRICE_MAIL = {
  monthly: process.env.STRIPE_PRICE_MAIL_MONTHLY,
  annual: process.env.STRIPE_PRICE_MAIL_ANNUAL,
};

const UPFRONT_PRICE_TABLE = {
  p3: { name: "Ofinova Domiciliación – 3 meses", unit_amount: 7500 },
  p6: { name: "Ofinova Domiciliación – 6 meses", unit_amount: 15000 },
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 },
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 40800 },
};

const MAIL_NET_EUR_CENTS = 390;

const SITE_URL = process.env.SITE_URL || process.env.APP_BASE_URL || "https://ofinova-madrid.es";
const successUrl = `${SITE_URL}/confirmacion?session_id={CHECKOUT_SESSION_ID}&status=success&paid=1`;
const cancelUrl = `${SITE_URL}/pago?status=cancelled`;

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

function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) { out[k] = typeof v === "string" ? v : JSON.stringify(v); }
  return out;
}

const toInt = (v, d = 0) => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : d;
};

const toBool = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());

function normMailPlan(s) {
  const t = String(s ?? "").toLowerCase();
  return (t.includes("lite") || t.includes("pro")) ? "active" : "";
}

function normIndustry(s) { return String(s ?? "").trim(); }

const firstNonEmpty = (...vals) => {
  for (const v of vals) {
    const s = typeof v === "string" ? v : (v == null ? "" : String(v));
    if (s && s.trim()) return s.trim();
  }
  return "";
};

// ★★★ 2026-09-15 신규: 광고 추적값 추출 ★★★
// 프론트가 어떤 형태로 보내든 잡아내도록 여러 경로를 모두 확인한다.
//   1) req.body.tracking.gclid      (권장 형태)
//   2) req.body.gclid               (최상위)
//   3) req.body.metadata.gclid      (기존 metadata 안)
// 값이 없으면 빈 문자열 → 기존 동작과 동일하게 안전하게 넘어감.
function extractTracking(body = {}) {
  const t = (body && typeof body.tracking === "object" && body.tracking) ? body.tracking : {};
  const m = (body && typeof body.metadata === "object" && body.metadata) ? body.metadata : {};

  const pick = (...keys) => {
    for (const k of keys) {
      const v = firstNonEmpty(t[k], body[k], m[k]);
      if (v) return v.slice(0, 500); // 과도한 길이 방지
    }
    return "";
  };

  return {
    gclid:        pick("gclid"),
    gbraid:       pick("gbraid"),
    wbraid:       pick("wbraid"),
    utm_source:   pick("utm_source", "utmSource"),
    utm_medium:   pick("utm_medium", "utmMedium"),
    utm_campaign: pick("utm_campaign", "utmCampaign"),
    utm_content:  pick("utm_content", "utmContent"),
    utm_term:     pick("utm_term", "utmTerm"),
    landing_page: pick("landing_page", "landingPage"),
    referrer:     pick("referrer", "referer"),
  };
}

const MAKE_CHECKOUT_WEBHOOK_URL = process.env.MAKE_CHECKOUT_WEBHOOK_URL || "";
function postToMake(payload) {
  if (!MAKE_CHECKOUT_WEBHOOK_URL) return;
  try {
    fetch(MAKE_CHECKOUT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(payload) }),
    }).catch(() => {});
  } catch {}
}

// ── 할인코드 재검증 (프론트에서 온 값을 그대로 믿지 않고 Stripe에 다시 물어봄) ──
async function resolvePromotionCode(rawCode) {
  const cleanCode = String(rawCode || "").trim().toUpperCase();
  if (!cleanCode) return null;

  try {
    const list = await stripe.promotionCodes.list({
      code: cleanCode,
      active: true,
      limit: 1,
    });
    const promo = list.data[0];
    if (!promo) return null;
    if (!promo.coupon || promo.coupon.valid === false) return null;
    if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) return null;

    return {
      id: promo.id,
      code: cleanCode,
      percent_off: promo.coupon.percent_off || 0,
    };
  } catch (err) {
    console.error("[resolvePromotionCode] error:", err);
    return null;
  }
}

// ── 2026-11-05: 스페인 NIF(DNI·NIE·CIF) 형식 검사 ──
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function normNif(v) {
  return String(v || "").toUpperCase().replace(/[\s.\-]/g, "");
}
function isValidSpanishNif(raw) {
  const v = normNif(raw);
  // DNI: 8 dígitos + letra
  if (/^\d{8}[A-Z]$/.test(v)) return DNI_LETTERS[parseInt(v.slice(0, 8), 10) % 23] === v[8];
  // NIE: X/Y/Z + 7 dígitos + letra
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) {
    const n = "XYZ".indexOf(v[0]) + v.slice(1, 8);
    return DNI_LETTERS[parseInt(n, 10) % 23] === v[8];
  }
  // CIF: letra + 7 dígitos + control (dígito o letra)
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v)) {
    const digits = v.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      let d = parseInt(digits[i], 10);
      if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    const c = (10 - (sum % 10)) % 10;
    const ctrl = v[8];
    return ctrl === String(c) || ctrl === "JABCDEFGHI"[c];
  }
  return false;
}

// Pago에서 받은 NIF로 Stripe 고객을 미리 만든다. 실패하면 null → 이전 방식으로.
async function precreateCustomer({ email, name, nif, leadId }) {
  try {
    const params = {
      name: name || undefined,
      email: email || undefined,
      preferred_locales: ["es-ES"],
      tax_id_data: [{ type: "es_cif", value: normNif(nif) }],
      metadata: { lead_id: leadId, source: "framer/pago-nif" },
    };
    const c = await stripe.customers.create(params);
    return c?.id || null;
  } catch (err) {
    console.error("[precreateCustomer] failed, fallback to checkout tax_id_collection:", err?.message);
    return null;
  }
}

// Stripe 결제 버튼 옆 안내문 (Pago에서 NIF를 못 받았을 때만)
const NIF_HINT = {
  submit: {
    message:
      "Para tu factura, en «Información del IVA»: si eres autónomo o tu empresa está en constitución, escribe tu nombre, elige «ES NIF» en el desplegable y pon tu DNI o NIE. Si ya tienes sociedad, pon su nombre y su CIF (también con «ES NIF»).",
  },
};

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, payMode, promoCode, metadata = {} } = req.body || {};
    if (!planId || !UPFRONT_PRICE_TABLE[planId]) return res.status(400).json({ error: "Invalid planId" });

    const months = toInt(metadata.months, PLAN_MONTHS[planId]) || PLAN_MONTHS[planId];
    const leadId = String(metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? "").trim();
    if (!leadId) return res.status(400).json({ error: "Missing lead_id/orderId" });

    const companyLegalName = firstNonEmpty(metadata.company_legal_name, metadata.companyLegalName);
    const companyCifNif = firstNonEmpty(metadata.company_cif_nif, metadata.companyCifNif);
    const mailEnabled = toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;
    const mailPlan = normMailPlan(metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? "");
    const wantGestoria = toBool(metadata.want_gestoria) || toBool(metadata.wantGestoria) || false;
    const industry = normIndustry(firstNonEmpty(metadata.industry, metadata.sector, metadata.actividad, req.body?.industry));
    const mode = (payMode || metadata.payMode || "payment").toLowerCase();

    const shippingTop = (req.body && typeof req.body.shipping === "object") ? req.body.shipping : undefined;
    const shippingAddress = firstNonEmpty(shippingTop?.address, req.body.address, metadata.address);
    const shippingNotes = firstNonEmpty(shippingTop?.notes, req.body.notes, metadata.notes);

    // ★★★ 2026-09-15 신규: 광고 추적값 추출 ★★★
    const tracking = extractTracking(req.body);

    // ── 할인코드 재검증 (있으면) ──
    const promo = await resolvePromotionCode(promoCode || metadata.promoCode || metadata.promo_code);

    // ── 2026-11-05: Pago에서 온 NIF → Stripe 고객 미리 만들기 ──
    const billingNif = normNif(firstNonEmpty(req.body?.billing_nif, metadata.billing_nif));
    const billingName = firstNonEmpty(req.body?.billing_name, metadata.billing_name).slice(0, 200);
    let preCustomerId = null;
    if (billingNif && isValidSpanishNif(billingNif)) {
      preCustomerId = await precreateCustomer({ email, name: billingName, nif: billingNif, leadId });
    }
    // 고객을 미리 만들었으면 Stripe 창의 NIF 칸은 끄고, 아니면 이전처럼 필수 + 안내문
    const checkoutCustomerParams = preCustomerId
      ? { customer: preCustomerId, customer_update: { address: "auto", name: "never" } }
      : { customer_email: email || undefined };
    const taxIdParams = preCustomerId
      ? {}
      : { tax_id_collection: { enabled: true, required: "if_supported" }, custom_text: NIF_HINT };

    const sessMeta = {
      ...metadata, lead_id: leadId, orderId: leadId, planId, months, mailEnabled: String(mailEnabled ? 1 : 0),
      mailPlan: mailPlan || "", want_gestoria: String(wantGestoria ? 1 : 0), mode,
      company_legal_name: companyLegalName || "", company_cif_nif: companyCifNif || "",
      industry: industry || "", shipping_address: shippingAddress || "", shipping_notes: shippingNotes || "",
      promo_code: promo ? promo.code : "",
      promo_applied: promo ? "1" : "0",
      promo_percent_off: promo ? String(promo.percent_off) : "0",
      billing_nif: billingNif || "",
      billing_nif_precreated: preCustomerId ? "1" : "0",
    };

    // ★★★ 2026-09-16 신규 (B안): 광고 추적값을 Stripe metadata에도 추가 ★★★
    // - 값이 있는 항목만 추가 (빈 값은 건너뜀)
    // - Stripe metadata 키 한도 50개를 넘기게 되면 추가하지 않음 → 결제 에러 방지
    const STRIPE_META_KEY_LIMIT = 50;
    for (const k of ["gclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const v = tracking[k];
      if (!v) continue;
      if (!(k in sessMeta) && Object.keys(sessMeta).length >= STRIPE_META_KEY_LIMIT) break;
      sessMeta[k] = v;
    }

    const upfrontConfig = UPFRONT_PRICE_TABLE[planId];
    const totalUpfrontEur = Math.round(upfrontConfig.unit_amount / 100);
    const monthlyPriceEur = mode === "subscription" ? MONTHLY_SUBSCRIPTION_PRICE_EUR : MONTHLY_UPFRONT_PRICE_EUR;
    const totalContractPriceEur = mode === "subscription" ? months * MONTHLY_SUBSCRIPTION_PRICE_EUR : totalUpfrontEur;

    postToMake({
      schema_version: "v1", event: "checkout.submit", meta: { lead_id: leadId, pay_mode_choice: mode },
      company: { plan_id: planId, months, price_month: monthlyPriceEur, total_price: totalContractPriceEur },
      options: { mail_enabled: mailEnabled ? 1 : 0, mail_plan: mailPlan || "none", want_gestoria: wantGestoria ? 1 : 0, industry: industry || "" },
      shipping: { address: shippingAddress, notes: shippingNotes },
      company_legal_name: companyLegalName || "", company_cif_nif: companyCifNif || "", customer_email: email || "",
      promo_code: promo ? promo.code : "",
      promo_applied: promo ? 1 : 0,

      // ★★★ 2026-09-15 신규: 광고 추적 블록 ★★★
      // Make에서 "tracking" 하위 항목으로 나타남 → Airtable 필드에 매핑
      tracking: {
        gclid:        tracking.gclid,
        gbraid:       tracking.gbraid,
        wbraid:       tracking.wbraid,
        utm_source:   tracking.utm_source,
        utm_medium:   tracking.utm_medium,
        utm_campaign: tracking.utm_campaign,
        utm_content:  tracking.utm_content,
        utm_term:     tracking.utm_term,
        landing_page: tracking.landing_page,
        referrer:     tracking.referrer,
      },
    });

    /* ───── A) Subscription Mode ───── */
    if (mode === "subscription") {
      const domiPriceId = PRICE_DOMI_BY_PLAN[planId];
      if (!domiPriceId) return res.status(400).json({ error: "Missing monthly Price ID" });

      const line_items = [{ price: domiPriceId, quantity: 1 }];
      if (mailEnabled) {
        const mailPriceId = (planId === 'p12' || planId === 'p24') ? PRICE_MAIL.annual : PRICE_MAIL.monthly;
        line_items.push({ price: mailPriceId, quantity: 1 });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        billing_address_collection: "required",
        line_items,
        subscription_data: {
          default_tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
          metadata: stringifyMeta(sessMeta),
          discounts: promo ? [{ promotion_code: promo.id }] : undefined,
          // Se elimina cancel_at para evitar el error de parámetro desconocido en Stripe Checkout
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: stringifyMeta(sessMeta),
        ...checkoutCustomerParams,
        client_reference_id: leadId,
        locale: "auto",
        // 2026-11-05: NIF — Pago에서 받았으면 고객에 이미 있음 / 아니면 Stripe 창에서 필수 + 안내문
        ...taxIdParams,
        // NOTA: si se usa "discounts" en subscription_data no se puede usar allow_promotion_codes
        // en el nivel superior de la sesión a la vez; por eso el código se aplica ya validado aquí.
      });
      return res.status(200).json({ url: session.url, session_id: session.id, promo_applied: !!promo });
    }

    /* ───── B) One-off Payment Mode ───── */
    const baseItem = UPFRONT_PRICE_TABLE[planId];
    const line_items = [{
      price_data: {
        currency: "eur", product_data: { name: baseItem.name },
        unit_amount: baseItem.unit_amount, tax_behavior: "exclusive",
      },
      quantity: 1,
      tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
    }];

    if (mailEnabled) {
      line_items.push({
        price_data: {
          currency: "eur", product_data: { name: `Gestión de correo (${months} meses)` },
          unit_amount: MAIL_NET_EUR_CENTS, tax_behavior: "exclusive",
        },
        quantity: months,
        tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      billing_address_collection: "required",
      line_items,
      ...checkoutCustomerParams,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: stringifyMeta(sessMeta),
      payment_intent_data: { metadata: stringifyMeta(sessMeta) },
      discounts: promo ? [{ promotion_code: promo.id }] : undefined,
      client_reference_id: leadId,
      locale: "auto",
      // 2026-09-28: one-off (연납) 결제도 Customer + Factura(Invoice PDF) 자동 생성
      ...(preCustomerId ? {} : { customer_creation: "always" }),
      invoice_creation: { enabled: true },
      // 2026-11-05: NIF — Pago에서 받았으면 고객에 이미 있음 / 아니면 Stripe 창에서 필수 + 안내문
      ...taxIdParams,
    });

    return res.status(200).json({ url: session.url, session_id: session.id, promo_applied: !!promo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}
