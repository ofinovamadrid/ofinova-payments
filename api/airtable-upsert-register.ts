// /api/airtable-upsert-register.ts
// v1.1 — Upsert: update by lead_id, or create if not exists. CORS + JSON result.

import type { VercelRequest, VercelResponse } from '@vercel/node'

const API_KEY = process.env.AIRTABLE_API_KEY!
const BASE_ID = process.env.AIRTABLE_BASE_ID!
const TABLE_ID = process.env.AIRTABLE_TABLE_ID! // table id or name
const CORS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function setCORS(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || ''
  const allow =
    (CORS.length === 0 && origin) ||
    (CORS.includes(origin) ? origin : 'https://ofinova-madrid.es')

  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.setHeader('Vary', 'Origin')
}

async function airtableFetch(path: string, init?: RequestInit) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
  }
  if (init?.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch { /* no-op */ }
  return { ok: res.ok, status: res.status, json, text }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCORS(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  if (!API_KEY || !BASE_ID || !TABLE_ID) {
    return res.status(500).json({ error: 'missing_env', need: ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE_ID'] })
  }

  try {
    const { lead_id, register_type, customer_type, meta_stage } = (req.body || {}) as {
      lead_id?: string
      register_type?: string
      customer_type?: string
      meta_stage?: string
    }

    if (!lead_id) return res.status(400).json({ error: 'lead_id_required' })

    // 업데이트할 필드 구성
    const fields: Record<string, any> = {}
    if (typeof register_type !== 'undefined') fields['register_type'] = String(register_type)
    if (typeof customer_type !== 'undefined') fields['customer_type'] = String(customer_type)
    if (typeof meta_stage !== 'undefined') fields['meta_stage'] = String(meta_stage)
    fields['meta_updated_at'] = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // 1) lead_id로 기존 레코드 조회
    const formula = encodeURIComponent(`{lead_id} = "${lead_id}"`)
    const find = await airtableFetch(`${TABLE_ID}?filterByFormula=${formula}&maxRecords=1`)

    if (!find.ok) {
      return res.status(find.status).json({ error: 'airtable_find_failed', detail: find.json || find.text })
    }

    const recs: any[] = find.json?.records || []

    if (recs.length > 0) {
      // 2a) 있으면 PATCH (업데이트)
      const recId = recs[0].id
      const patch = await airtableFetch(`${TABLE_ID}/${recId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields }),
      })
      if (!patch.ok) {
        return res.status(patch.status).json({ error: 'airtable_update_failed', detail: patch.json || patch.text })
      }
      return res.status(200).json({ updated: true, recordId: patch.json?.id || recId })
    } else {
      // 2b) 없으면 POST (생성)
      const create = await airtableFetch(`${TABLE_ID}`, {
        method: 'POST',
        body: JSON.stringify({ fields: { lead_id, ...fields } }),
      })
      if (!create.ok) {
        return res.status(create.status).json({ error: 'airtable_create_failed', detail: create.json || create.text })
      }
      return res.status(201).json({ created: true, recordId: create.json?.id })
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) })
  }
}
