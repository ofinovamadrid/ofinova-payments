// api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// 총액(cent)
const PRICE_TABLE = {
  p3:  { name: "Ofinova Domiciliación – 3 meses",  unit_amount: 6900  }, // 69€
  p6:  { name: "Ofinova Domiciliación – 6 meses",  unit_amount: 12000 }, // 120€
  p12: { name: "Ofinova Domiciliación – 12 meses", unit_amount: 20400 }, // 204€
  p24: { name: "Ofinova Domiciliación – 24 meses", unit_amount: 33600 }, // 336€
};

// CORS 허용 (프레이머 도메인)
const ALLOWED_ORIGIN = process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, metadata } = req.body || {};
    if (!planId || !PRICE_TABLE[planId]) return res.status(400).json({ error: "Invalid planId" });

    const item = PRICE_TABLE[planId];
    const baseUrl = process.env.APP_BASE_URL || "https://spectacular-millions-373411.framer.app";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      automatic_tax: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: item.name },
            unit_amount: item.unit_amount,
            tax_behavior: "exclusive",
          },
          quantity: 1,
        },
      ],
      customer_email: email || undefined,
      success_url: `${baseUrl}/gracias?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pago?cancel=1`,
      metadata: { planId, ...(metadata || {}) },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
