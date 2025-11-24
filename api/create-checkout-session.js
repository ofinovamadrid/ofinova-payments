// api/create-checkout-session.js
// 2025-11 | v3.0 (annual-14eur-fix)
// - Change: Update upfront (prepago) amounts to 14€/mes for all durations
// - Change: Report correct monthly prices to Make (14€/mes prepago, 20€/mes suscripción)
// - Keep: { value: JSON.stringify(payload) } body shape for Make JSON module
// - Keep: company_legal_name & company_cif_nif forwarding to Make + Stripe metadata

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

/** Monthly prices used only for reporting to Make (NOT for charging) */
const MONTHLY_UPFRONT_PRICE_EUR = 14; // prepago: 14€/mes
const MONTHLY_SUBSCRIPTION_PRICE_EUR = 20; // suscripción: 20€/mes

/** Address monthly Prices (Stripe Price IDs) — subscription only */
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

/**
 * One-off (upfront) net amounts (without VAT), in cents.
 * New rule (2025-11): all prepago plans use 14€/mes.
 *  - 3 meses  ->  42€  ->  4200
 *  - 6 meses  ->  84€  ->  8400
 *  - 12 meses -> 168€  -> 16800
 *  - 24 meses -> 336€  -> 33600
 */
const UPFRONT_PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount:  4200 },
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount:  8400 },
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 16800 },
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 },
};

const MAIL_NET_EUR_CENTS = { lite: 390, pro: 990 };

/* ───────── Site URL ───────── */
const SITE_URL =
  process.env.SITE_URL ||
  process.env.APP_BASE_URL ||
  "https://ofinova-madrid.es";

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type", "Authorization");
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
const toInt = (v, d = 0) => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : d;
};
const toBool = (v) =>
  ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());
function normMailPlan(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("lite")) return "lite";
  if (t.includes("pro")) return "pro";
  if (t === "lite" || t === "pro") return t;
  return "";
}
const firstNonEmpty = (...vals) => {
  for (const v of vals) {
    const s = typeof v === "string" ? v : (v == null ? "" : String(v));
    if (s && s.trim()) return s.trim();
  }
  return "";
};

/* ───────── Fire-and-forget to Make ───────── */
const MAKE_CHECKOUT_WEBHOOK_URL = process.env.MAKE_CHECKOUT_WEBHOOK_URL || "";
function postToMake(payload) {
  if (!MAKE_CHECKOUT_WEBHOOK_URL) return;
  try {
    // IMPORTANT: Make JSON module expects "1.value" mapping.
    // Send { value: "<stringified-payload>" } so 2nd module can parse it.
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

    // NEW — normalize company fields from metadata
    const companyLegalName = firstNonEmpty(
      metadata.company_legal_name,
      metadata.companyLegalName
    );
    const companyCifNif = firstNonEmpty(
      metadata.company_cif_nif,
      metadata.companyCifNif
    );

    const mailEnabled = toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;
    const mailPlan = normMailPlan(metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? "");

    const wantGestoria =
      toBool(metadata.want_gestoria) || toBool(metadata.wantGestoria) || false;

    const mode = (payMode || metadata.payMode || "payment").toLowerCase();

    // ── Shipping: accept MANY field names/locations ──
    const shippingTop = (req.body && typeof req.body.shipping === "object") ? req.body.shipping : undefined;

    let shippingMeta = metadata.shipping;
    if (typeof shippingMeta === "string") {
      try { shippingMeta = JSON.parse(shippingMeta); } catch { shippingMeta = undefined; }
    }
    if (shippingMeta && typeof shippingMeta !== "object") shippingMeta = undefined;

    const shippingAddress = firstNonEmpty(
      // top-level shipping object
      shippingTop?.address,
      shippingTop?.mail_address,
      shippingTop?.shipping_address,
      // body top-level fields
      req.body.address,
      req.body.mail_address,
      req.body.shipping_address,
      // metadata.shipping object
      shippingMeta?.address,
      shippingMeta?.mail_address,
      shippingMeta?.shipping_address,
      // metadata top-level fields
      metadata.address,
      metadata.mail_address,
      metadata.shipping_address
    );

    const shippingNotes = firstNonEmpty(
      shippingTop?.notes,
      shippingTop?.mail_address_notes,
      shippingTop?.shipping_notes,
      req.body.notes,
      req.body.mail_address_notes,
      req.body.shipping_notes,
      shippingMeta?.notes,
      shippingMeta?.mail_address_notes,
      shippingMeta?.shipping_notes,
      metadata.notes,
      metadata.mail_address_notes,
      metadata.shipping_notes
    );

    // Build metadata for Stripe (string-only)
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
      // persist normalized company fields
      company_legal_name: companyLegalName || "",
      company_cif_nif: companyCifNif || "",
      // Keep in Stripe metadata for traceability
      shipping_address: shippingAddress || "",
      shipping_notes: shippingNotes || "",
    };

    // Pre-calc reporting amounts for Make
    const upfrontConfig = UPFRONT_PRICE_TABLE[planId];
    const totalUpfrontEur =
      upfrontConfig && typeof upfrontConfig.unit_amount === "number"
        ? Math.round(upfrontConfig.unit_amount / 100)
        : null;

    const monthlyPriceEur =
      mode === "subscription"
        ? MONTHLY_SUBSCRIPTION_PRICE_EUR
        : MONTHLY_UPFRONT_PRICE_EUR;

    const totalContractPriceEur =
      mode === "subscription"
        ? months * MONTHLY_SUBSCRIPTION_PRICE_EUR
        : totalUpfrontEur;

    // fire-and-forget → Make (INCLUDE company fields)
    postToMake({
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
        price_month: monthlyPriceEur,
        total_price: totalContractPriceEur,
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
      // NEW — forward these so Make Webhooks → JSON(2) can map them
      company_legal_name: companyLegalName || "",
      company_cif_nif: companyCifNif || "",
      customer_email: email || "",
    });

    /* ───── A) Subscription ───── */
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

    /* ───── B) One-off (payment) ───── */
    const baseItem = UPFRONT_PRICE_TABLE[planId];
    const line_items = [
      {
        price_data: {
          currency: "eur",
          product_data: { name: baseItem.name },
          unit_amount: baseItem.unit_amount,
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
