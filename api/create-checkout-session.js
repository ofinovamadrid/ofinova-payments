// api/create-checkout-session.js
// 2025-10 | v2.5
// - Ensure Make POST is delivered: await fetch with 1s timeout
// - Keep JSON-Parse(1.value) shape: send { value: "<json>" }
// - Shipping: top-level -> metadata.shipping -> address/notes fallbacks

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const TAX_RATE_ID =
  process.env.STRIPE_TAX_RATE_ID || "txr_1S9RT93pToW48VXP6fB9vkUy";

const PLAN_MONTHS = { p3: 3, p6: 6, p12: 12, p24: 24 };
const PRICE_MONTH_BY_PLAN = { p3: 23, p6: 20, p12: 17, p24: 14 };
const PRICE_DOMI_BY_PLAN = {
  p3: process.env.STRIPE_PRICE_DOMI_23,
  p6: process.env.STRIPE_PRICE_DOMI_20,
  p12: process.env.STRIPE_PRICE_DOMI_17,
  p24: process.env.STRIPE_PRICE_DOMI_14,
};
const PRICE_MAIL = {
  lite: process.env.STRIPE_PRICE_MAIL_LITE_390,
  pro: process.env.STRIPE_PRICE_MAIL_PRO_990,
};
const UPFRONT_PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  },
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 },
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 },
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 },
};
const MAIL_NET_EUR_CENTS = { lite: 390, pro: 990 };

const SITE_URL =
  process.env.SITE_URL ||
  process.env.APP_BASE_URL ||
  "https://ofinova-madrid.es";

const successUrl = `${SITE_URL}/confirmacion?session_id={CHECKOUT_SESSION_ID}&status=success&paid=1`;
const cancelUrl  = `${SITE_URL}/pago?status=cancelled`;

const RAW_ALLOWED =
  process.env.CORS_ALLOWED_ORIGINS ||
  [
    "https://ofinova-madrid.es",
    "https://www.ofinova-madrid.es",
    "https://*.framer.app",
    "https://ofinova.vercel.app",
    "http://localhost:3000",
  ].join(",");
const ALLOWED = RAW_ALLOWED.split(",").map(s=>s.trim()).filter(Boolean);
function matchWildcard(pattern, origin) {
  if (!pattern.includes("*")) return pattern === origin;
  try {
    const u = new URL(origin);
    const hostPattern = pattern.split("://")[1];
    const re = new RegExp("^" + hostPattern.replace(/\./g,"\\.").replace(/\*/g,".*") + "$");
    const proto = pattern.split("://")[0];
    return u.protocol.replace(":","")===proto && re.test(u.host);
  } catch { return false; }
}
function isAllowedOrigin(origin){ return origin && ALLOWED.some(p=>matchWildcard(p,origin)); }
function applyCors(req,res){
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin(origin)?origin:"https://ofinova-madrid.es");
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age","86400");
}

function stringifyMeta(obj={}) {
  const out={}; for (const [k,v] of Object.entries(obj)) out[k]=typeof v==="string"?v:JSON.stringify(v);
  return out;
}
const toInt = (v,d=0)=>{ const n=parseInt(String(v??"").trim(),10); return Number.isFinite(n)?n:d; };
const toBool = v => ["1","true","yes","on"].includes(String(v??"").toLowerCase());
function normMailPlan(s){ const t=String(s??"").toLowerCase(); if(t.includes("lite"))return"lite"; if(t.includes("pro"))return"pro"; if(t==="lite"||t==="pro")return t; return ""; }
const firstNonEmpty=(...vals)=> (vals.find(v=>String(v??"").trim().length) ?? "").toString().trim();
function safeParseJSON(s,fallback={}){ try{return JSON.parse(s);}catch{return fallback;} }

/* ── Make webhook ── */
const MAKE_CHECKOUT_WEBHOOK_URL = process.env.MAKE_CHECKOUT_WEBHOOK_URL || "";
async function postToMake(payload){
  if (!MAKE_CHECKOUT_WEBHOOK_URL) return;
  // 서버리스에서 조기 종료 방지: 1초만 기다림
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), 1000);
  try {
    await fetch(MAKE_CHECKOUT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Make JSON-Parse(1.value) 호환
      body: JSON.stringify({ value: JSON.stringify(payload) }),
      signal: ac.signal,
    });
  } catch { /* ignore */ }
  finally { clearTimeout(timer); }
}

/* ── Handler ── */
export default async function handler(req,res){
  applyCors(req,res);
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="POST") return res.status(405).json({error:"Method not allowed"});

  try {
    const { planId, email, payMode, metadata = {}, shipping: shippingTop = {} } = req.body || {};
    if (!planId || !UPFRONT_PRICE_TABLE[planId]) {
      return res.status(400).json({ error: "Invalid planId" });
    }

    const months = toInt(metadata.months, PLAN_MONTHS[planId]) || PLAN_MONTHS[planId];
    const leadId = String(metadata.lead_id ?? metadata.leadId ?? metadata.orderId ?? "").trim();
    if (!leadId) return res.status(400).json({ error: "Missing lead_id/orderId in metadata" });

    const mailEnabled = toBool(metadata.mailEnabled) || toBool(metadata.mail_enabled) || false;
    const mailPlan = normMailPlan(metadata.mail ?? metadata.mail_plan ?? metadata.mailPlan ?? "");
    const wantGestoria = toBool(metadata.want_gestoria) || toBool(metadata.wantGestoria) || false;

    const shippingMeta = typeof metadata.shipping === "string"
      ? safeParseJSON(metadata.shipping, {})
      : (metadata.shipping || {});
    const shippingAddress = firstNonEmpty(shippingTop?.address, shippingMeta?.address, metadata.address);
    const shippingNotes   = firstNonEmpty(shippingTop?.notes,   shippingMeta?.notes,   metadata.notes);

    const mode = (payMode || metadata.payMode || "payment").toLowerCase();

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
    };

    // Make에 먼저 보고(1초 제한으로 await)
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
      shipping: { address: shippingAddress, notes: shippingNotes },
      customer_email: email || "",
    });

    /* Subscription */
    if (mode==="subscription"){
      const domiPriceId = PRICE_DOMI_BY_PLAN[planId];
      if (!domiPriceId) return res.status(400).json({ error: `Missing monthly Price ID for planId=${planId}.` });

      const line_items=[{price:domiPriceId,quantity:1}];
      if (mailEnabled) {
        const mailPriceId = PRICE_MAIL[mailPlan];
        if (!mailPriceId) return res.status(400).json({ error:"Mail plan invalid or missing env Price ID." });
        line_items.push({price:mailPriceId,quantity:1});
      }

      const session = await stripe.checkout.sessions.create({
        mode:"subscription",
        billing_address_collection:"required",
        line_items,
        subscription_data: TAX_RATE_ID
          ? { default_tax_rates:[TAX_RATE_ID], metadata: stringifyMeta(sessMeta) }
          : { metadata: stringifyMeta(sessMeta) },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: stringifyMeta(sessMeta),
        customer_email: email || undefined,
        client_reference_id: leadId,
        locale:"auto",
      });

      return res.status(200).json({ url: session.url, lead_id: leadId, session_id: session.id, mode:"subscription" });
    }

    /* One-off */
    const baseItem = UPFRONT_PRICE_TABLE[planId];
    const line_items=[{
      price_data:{ currency:"eur", product_data:{name:baseItem.name}, unit_amount:baseItem.unit_amount, tax_behavior:"exclusive" },
      quantity:1,
      tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
    }];

    if (mailEnabled && mailPlan){
      const unit = MAIL_NET_EUR_CENTS[mailPlan];
      if (unit){
        line_items.push({
          price_data:{
            currency:"eur",
            product_data:{ name:`Gestión de correo — ${mailPlan==="lite"?"Mail Lite":"Mail Pro"} · ${months} meses` },
            unit_amount:unit,
            tax_behavior:"exclusive",
          },
          quantity:months,
          tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode:"payment",
      automatic_tax:{enabled:false},
      billing_address_collection:"required",
      line_items,
      customer_email: email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: stringifyMeta(sessMeta),
      payment_intent_data:{ metadata: stringifyMeta(sessMeta) },
      client_reference_id: leadId,
      locale:"auto",
    });

    return res.status(200).json({ url: session.url, lead_id: leadId, session_id: session.id, mode:"payment" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}
