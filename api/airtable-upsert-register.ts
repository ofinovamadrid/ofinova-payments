// /api/airtable-upsert-register.ts
// v1.2 — No-Auth (Origin allowlist only) + Airtable upsert by lead_id
import type { VercelRequest, VercelResponse } from '@vercel/node'

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY!
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID!  // table name 또는 tbl... ID 둘 다 가능
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'https://ofinova-madrid.es,http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function setCors(res: VercelResponse, origin?: string) {
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function bad(res: VercelResponse, code: number, msg: string) {
  return res.status(code).json({ ok: false, error: msg })
}

type Payload = {
  lead_id: string
  register_type?: string
  customer_type?: 'autonomo' | 'empresa' | string
  meta_stage?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin || '') as string
  setCors(res, origin)

  // Preflight
  if (req.method === 'OPTIONS') return res.status(204).end()

  // Origin allowlist
  if (!origin || !CORS_ALLOWED_ORIGINS.includes(origin)) {
    return bad(res, 403, 'forbidden_origin')
  }

  if (req.method !== 'POST') {
    return bad(res, 405, 'method_not_allowed')
  }

  // --- parse body
  let body: Payload
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return bad(res, 400, 'invalid_json')
  }
  const { lead_id, register_type, customer_type, meta_stage } = body || {}
  if (!lead_id || typeof lead_id !== 'string') {
    return bad(res, 400, 'lead_id_required')
  }

  // --- build fields to upsert
  const fields: Record<string, any> = {
    meta_stage: meta_stage || 'type',
    meta_updated_at: new Date().toISOString(),
  }
  if (register_type) fields['register_type'] = String(register_type)
  if (customer_type) fields['customer_type'] = String(customer_type)

  // --- Airtable helpers
  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_ID)}`
  const headers = {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  }

  // 1) find by lead_id
  const formula = `({lead_id} = "${lead_id.replace(/"/g, '\\"')}")`
  const findUrl = `${baseUrl}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`
  const found = await fetch(findUrl, { headers }).then(r => r.json() as any).catch(() => null)

  const recId: string | undefined = found?.records?.[0]?.id

  // 2) upsert (patch if exists, else create)
  if (recId) {
    await fetch(`${baseUrl}/${recId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields }),
    }).then(r => r.json()).catch(() => null)
  } else {
    await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [{ fields: { lead_id, ...fields } }] }),
    }).then(r => r.json()).catch(() => null)
  }

  // Done
  return res.status(204).end()
}
