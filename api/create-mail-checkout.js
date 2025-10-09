// /api/create-mail-checkout.js
// 2025-10 | v1.0
// 목적: 기존 고객(cus_...)에게 "우편물(月) 구독"만 추가하는 Checkout 링크 생성
// 사용법(POST JSON): { customerId: "cus_xxx", plan: "lite" | "pro", trialEnd: 1730419200(optional, UNIX) }

import Stripe from "stripe";

const { STRIPE_SECRET_KEY, STRIPE_PRICE_MAIL_LITE_390, STRIPE_PRICE_MAIL_PRO_990, STRIPE_TAX_RATE_ID } = process.env;
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const PRICE_MAIL = {
  lite: STRIPE_PRICE_MAIL_LITE_390,
  pro: STRIPE_PRICE_MAIL_PRO_990,
};

const SITE_URL = process.env.SITE_URL || process.env.APP_BASE_URL || "https://ofinova-madrid.es";
const successUrl = `${SITE_URL}/confirmacion?session_id={CHECKOUT_SESSION_ID}&status=success&paid=1`;
const cancelUrl  = `${SITE_URL}/pago?status=cancelled`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { customerId, plan = "lite", trialEnd, metadata = {} } = req.body || {};
    if (!customerId || !String(customerId).startsWith("cus_")) {
      return res.status(400).json({ error: "customerId(cus_...) is required" });
    }
    const p = String(plan).toLowerCase();
    if (!PRICE_MAIL[p]) return res.status(400).json({ error: "plan must be 'lite' or 'pro'" });

    const subscription_data = {
      metadata: {
        feature: "mail_addon_only",
        mail_plan: p,
        ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
      },
      default_tax_rates: STRIPE_TAX_RATE_ID ? [STRIPE_TAX_RATE_ID] : undefined,
    };

    // 결제일 정렬이 필요하면 trial_end(UNIX timestamp) 받기
    if (trialEnd && Number.isFinite(Number(trialEnd))) {
      subscription_data.trial_end = Number(trialEnd); // e.g., 기존 도미실리오 갱신일 자정(UTC)
      subscription_data.proration_behavior = "none";
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,               // 핵심: 기존 Customer에 반드시 연결
      line_items: [{ price: PRICE_MAIL[p], quantity: 1 }],
      subscription_data,
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: metadata?.lead_id || metadata?.orderId || undefined,
      locale: "auto",
    });

    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}
