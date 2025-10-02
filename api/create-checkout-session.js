// api/create-checkout-session.js
// 2025-10 | v2.5
// - Robust shipping mapping: read from req.body.shipping / req.body.* / metadata.shipping / metadata.*
// - Send to Make as { value: JSON.stringify(payload) } (so JSON step keeps using 1.value)
// - Keep: pay_mode_choice / want_gestoria reporting
// - CORS hardening + wildcard
// - Supports one-off (payment) and monthly (subscription)

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

/** Monthly price (for reporting to Make) */
const PRICE_MONTH_BY_PLAN = { p3: 23, p6: 20, p12: 17, p24: 14 };

/** Address (domiciliación) monthly Prices (Stripe Price IDs) — subscription only */
const PRICE_DOMI_BY_PLAN = {
  p3: process.env.STRIPE_PRICE_DOMI_23,
  p6: process.env.STRIPE_PRICE_DOMI_20,
  p12: process.env.STRIPE_PRICE_DOMI_17,
  p24: process.env.STRIPE_PRICE_DOMI_14,
};

/** Mail management monthly Prices (Stripe Price IDs) */
const PRICE_MAIL = {
  lite: process.env.STRIPE_PRICE_MAIL_LITE_390,
  pro: process.env.STRIPE_PRICE_MAIL_PRO_990,
};

/** One-off (upfront) net amounts (without VAT), in cents */
const UPFRONT_PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  },
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 },
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 },
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 },
};

/** Mail (upfront: monthly net × months), in cents */
const MAIL_NET_EUR_CENTS = { lite: 390, pro: 990 };

/* ───────── Site URL (redirect base) ───────── */
const SITE_URL =
  process.env.SITE_URL || process.env.APP_BASE_URL || "https://ofinova-madrid.es";

/* Common redirect URLs */
const successUrl = `${SITE_URL}/confirmacion?session_id={CHECKOUT_SESSION_ID}&status=success&paid=1`;
const cancelUrl  = `${SITE_URL}/pago?status=cancelled`;

/* ───────── CORS ───────── */
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

/* ───────── Utils ───────── */
function stringifyMeta(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}
const toInt  = (v, d = 0) => { const n = parseInt(String(v ?? "").trim(), 10); return Number.isFinite(n) ? n : d; };
const toBool = (v) => ["1","true","yes","on"].includes(String(v ?? "").toLowerCase());
function normMailPlan(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("lite")) return "lite";
  if (t.includes("pro"))  return "pro";
  if (t === "lite" || t === "pro") return t;
  return "";
}
// pick first non-empty string
function pick(...vals) {
  for (const v of vals) {
    const s = v == null ? "" : String(v).trim();
    if (s) return s;
  }
  return "";
}

/* ───────── Fire-and-forget POST to Make ───────── */
const MAKE_CHECKOUT_WEBHOOK_URL = process.env.MAKE_CHECKOUT_WEBHOOK_URL || "";
async function postToMake(payload) {
  if (!MAKE_CHECKOUT_WEBHOOK_URL) return;
  try {
    await fetch(MAKE_CHECKOUT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // IMPORTANT: Make JSON step expects 1.value
      body: JSON.stringify({ value: JSON.stringify(payload) }),
    }).catch(() => {});
  } catch { /* swallow */ }
}

/* ───────── Handler ───────── */
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")  return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, payMode, metadata = {} } = req.body || {};
    if (!planId || !UPFRONT_PRICE_TABLE[planId]) {
      return res.status(400).json({ error: "Invalid planId" });
    }

    const months = toInt(metadata.months, PLAN_MONTHS[planId]) || PLAN_MONTHS[planId];

    const leadId = String(
      metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? ""
    ).trim();
    if (!leadId) return res.status(400).json({ error: "Missing lead_id/orderId in metadata" });

    const mailEnabled = toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;
    const mailPlan    = normMailPlan(metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? "");
    const wantGestoria = toBool(metadata.want_gestoria) || toBool(metadata.wantGestoria) || false;
    const mode = (payMode || metadata.payMode || "payment").toLowerCase();

    // --- Robust shipping extraction (req.body + metadata, both plain and nested) ---
    let bodyShipping = {};
    try {
      bodyShipping =
        typeof req.body?.shipping === "string"
          ? JSON.parse(req.body.shipping)
          : (req.body?.shipping || {});
    } catch { bodyShipping = {}; }

    let metaShipping = {};
    try {
      metaShipping =
        typeof metadata?.shipping === "string"
          ? JSON.parse(metadata.shipping)
          : (metadata?.shipping || {});
    } catch { metaShipping = {}; }

    const shippingAddress = pick(
      bodyShipping.address,
      req.body?.address,
      req.body?.mail_address,
      metaShipping.address,
      metadata.address,
      metadata.mail_address
    );
    const shippingNotes = pick(
      bodyShipping.notes,
      req.body?.notes,
      req.body?.addressNotes,
      req.body?.mail_address_notes,
      metaShipping.notes,
      metadata.notes,
      metadata.addressNotes,
      metadata.mail_address_notes
    );
    // -------------------------------------------------------------------------------

    const sessMeta = {
      ...metadata,
      lead_id: leadId,
      orderId: leadId,
      planId,
      months,
      mailEnabled: String(mailEnabled ? 1 : 0),
      mailPlan: mailPlan || "",
      want_gestoria: String(wantGestoria ? 1 : 0),
      mode, // "payment" | "subscription"
    };

    // Send to Make (non-blocking)
    await postToMake({
      schema_version: "v1",
      event: "checkout.submit",
      meta: {
        lead_id: leadId,
        source: "vercel-api",
        env: "prod",
        stage: "payment",
        pay_mode_choice: mode,
      },
      company: {
        plan_id: planId,
        months,
        price_month: PRICE_MONTH_BY_PLAN[planId] ?? null,
        total_price: UPFRONT_PRICE_TABLE[planId]?.unit_amount
          ? Math.round(UPFRONT_PRICE_TABLE[planId].unit_amount / 100)
          : null,
      },
      options: {
        mail_enabled: mailEnabled ? 1 : 0,
        mail_plan: mailPlan || "none",
        want_gestoria: wantGestoria ? 1 : 0,
      },
      shipping: {
        address: shippingAddress,
        notes: shippingNotes,
      },
      customer_email: email || "",
    });

    /* ───── A) Subscription (monthly) ───── */
    if (mode === "subscription") {
      const domiPriceId = PRICE_DOMI_BY_PLAN[planId];
      if (!domiPriceId) {
        return res.status(400).json({
          error: `Missing monthly Price ID for planId=${planId}. Check STRIPE_PRICE_DOMI_14/17/20/23 envs.`,
        });
      }

      const line_items = [{ price: domiPriceId, quantity: 1 }];
      if (mailEnabled) {
        const mailPriceId = PRICE_MAIL[mailPlan];
        if (!mailPriceId) {
          return res.status(400).json({
            error: "Mail plan enabled but invalid (lite/pro) or missing env Price ID.",
          });
        }
        line_items.push({ price: mailPriceId, quantity: 1 });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        billing_address_collection: "required",
        line_items,
        subscription_data: TAX_RATE_ID
          ? { default_tax_rates: [TAX_RATE_ID], metadata: stringifyMeta(sessMeta) }
          : { metadata: stringifyMeta(sessMeta) },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: stringifyMeta(sessMeta),
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

    /* ───── B) One-off (upfront) payment ───── */
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
      const unit = MAIL_NET_EUR_CENTS[mailPlan];
      if (unit) {
        line_items.push({
          price_data: {
            currency: "eur",
            product_data: {
              name: `Gestión de correo — ${mailPlan === "lite" ? "Mail Lite" : "Mail Pro"} · ${months} meses`,
            },
            unit_amount: unit,
            tax_behavior: "exclusive",
          },
          quantity: months,
          tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
        });
      }
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

    return res.status(200).json({
      url: session.url,
      lead_id: leadId,
      session_id: session.id,
      mode: "payment",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}
