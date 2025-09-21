// /api/airtable-upsert-register.ts
// Upsert by lead_id → fields: register_type (+ customer_type / meta_stage)
// Env: AIRTABLE_PAT, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID
// CORS + OPTIONS 지원 (Framer 등 외부 도메인에서 호출 가능)

type ReqBody = {
  lead_id: string;
  register_type: "alta" | "cambio" | string;
  customer_type?: "autonomo" | "empresa" | string;
  meta_stage?: string;
};

const ALLOW_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// 기본: * 허용 (원하면 환경변수로 좁혀라)
function setCors(res: any, origin?: string) {
  const allow = ALLOW_ORIGINS.length ? (ALLOW_ORIGINS.includes(origin || "") ? origin : ALLOW_ORIGINS[0]) : "*";
  res.setHeader("Access-Control-Allow-Origin", allow || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req: any, res: any) {
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { lead_id, register_type, customer_type, meta_stage } = (req.body || {}) as ReqBody;

    if (!lead_id || !register_type) {
      return res.status(400).json({ error: "lead_id and register_type are required" });
    }

    const apiUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;
    const r = await fetch(apiUrl, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${process.env.AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: ["lead_id"] },
        records: [
          {
            fields: {
              lead_id,
              register_type,
              ...(customer_type ? { customer_type } : {}),
              ...(meta_stage ? { meta_stage } : {}),
            },
          },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ airtable_error: data, hint: "Check base/table IDs and PAT scopes" });
    }

    return res.status(200).json({ ok: true, upserted: data?.records?.map((x: any) => x?.id) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
