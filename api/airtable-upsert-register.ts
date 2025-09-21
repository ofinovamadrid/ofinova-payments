// Upsert by lead_id → fields: register_type (+ customer_type / meta_stage 옵션)
// Env 필요: AIRTABLE_PAT, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID
// Airtable: PATCH + performUpsert로 안전 병합

type ReqBody = {
  lead_id: string;
  register_type: "alta" | "cambio" | string;
  customer_type?: "autonomo" | "empresa" | string;
  meta_stage?: string;
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { lead_id, register_type, customer_type, meta_stage } = (req.body || {}) as ReqBody;
    if (!lead_id || !register_type) {
      return res.status(400).json({ error: "lead_id and register_type are required" });
    }

    const r = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
      {
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
                register_type,                // ← 오늘 핵심
                ...(customer_type ? { customer_type } : {}),
                ...(meta_stage ? { meta_stage } : {}),
              },
            },
          ],
        }),
      }
    );

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json({ ok: true, upserted: data?.records?.map((x: any) => x?.id) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
