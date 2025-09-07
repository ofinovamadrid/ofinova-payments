// api/webhook.js — Stripe Webhook (Vercel Serverless)
// body 원문이 필요하므로 bodyParser 끔
import Stripe from "stripe"
import { buffer } from "micro"

export const config = { api: { bodyParser: false } }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
})

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    return res.status(405).end("Method Not Allowed")
  }

  let event
  const sig = req.headers["stripe-signature"]
  const buf = await buffer(req)

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET // Stripe 대시보드에서 복사한 whsec_...
    )
  } catch (err) {
    console.error("❌ Signature verify failed:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object
        console.log("✅ checkout.session.completed", session.id, session.customer_details?.email)
        break
      }
      case "payment_intent.succeeded": {
        const pi = event.data.object
        console.log("✅ payment_intent.succeeded", pi.id, pi.amount, pi.currency)
        break
      }
      case "charge.refunded": {
        const ch = event.data.object
        console.log("↩️ charge.refunded", ch.id, ch.amount_refunded)
        break
      }
      default:
        console.log("ℹ️ Unhandled event:", event.type)
    }
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error("⚠️ Webhook handler error:", err)
    return res.status(500).send("Webhook handler error")
  }
}
