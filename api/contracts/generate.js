import { json, send } from 'micro';
import { createClient } from '@supabase/supabase-js';
import Handlebars from 'handlebars';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// --- 환경변수 필요 ---
// SUPABASE_URL, SUPABASE_SERVICE_ROLE(or ANON_KEY), SUPABASE_BUCKET (e.g. 'contracts')
// PUBLIC_BASE_URL (배포 도메인) – 링크 생성에 사용
// RESEND_API_KEY (선택) – 이메일 발송시 사용
// FROM_EMAIL (선택) – 발신자 주소

// 템플릿 로딩(서버리스에서 파일 시스템 접근)
// Vercel은 api 파일과 같은 디렉터리 상대경로 접근 가능
import fs from 'fs/promises';
import path from 'path';
const __dirname = path.dirname(new URL(import.meta.url).pathname);

async function renderPdfFromHtml(html) {
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: true,
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
  });
  await browser.close();
  return pdfBuffer;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  let payload;
  try {
    payload = await json(req);
  } catch {
    return send(res, 400, { error: 'Invalid JSON' });
  }

  // 1) 필드 안전 기본값
  const data = {
    contract_id: payload.contract_id || `C-${Date.now()}`,
    contract_date: payload.contract_date || new Date().toISOString().slice(0, 10),
    customer_name: payload.customer_name || '',
    customer_email: payload.customer_email || '',
    customer_phone: payload.customer_phone || '',
    tax_id: payload.tax_id || '',
    entity_type: payload.entity_type || '',
    use_type: payload.use_type || '',
    plan_months: payload.plan_months || 12,
    mail_plan: payload.mail_plan || 'Lite',
    price_example: payload.price_example || '17',
    activation_datetime: payload.activation_datetime || new Date().toISOString(),
  };

  try {
    // 2) 템플릿 -> HTML
    const templatePath = path.join(__dirname, './contracts/template-es.hbs');
    const source = await fs.readFile(templatePath, 'utf8');
    const compile = Handlebars.compile(source);
    const html = compile(data);

    // 3) HTML -> PDF
    const pdf = await renderPdfFromHtml(html);

    // 4) Supabase 업로드 (선택)
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
    let publicUrl = null;

    if (supabaseUrl && supabaseKey && process.env.SUPABASE_BUCKET) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const filename = `contracts/${data.contract_id}.pdf`;
      const { error } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .upload(filename, pdf, { contentType: 'application/pdf', upsert: true });
      if (error) throw error;

      const { data: signed } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .createSignedUrl(filename, 60 * 60 * 24 * 7); // 7일
      publicUrl = signed?.signedUrl || null;
    }

    // 5) 이메일 발송 (선택)
    if (process.env.RESEND_API_KEY && data.customer_email) {
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'Ofinova <no-reply@ofinova.es>',
        to: data.customer_email,
        subject: `Contrato Ofinova (${data.contract_id})`,
        text: `Adjuntamos su contrato. ${publicUrl ? `Enlace: ${publicUrl}` : ''}`,
        attachments: [
          {
            filename: `Contrato-Ofinova-${data.contract_id}.pdf`,
            content: pdf.toString('base64'),
          },
        ],
      });
    }

    return send(res, 200, {
      ok: true,
      contract_id: data.contract_id,
      url: publicUrl,
    });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Failed to generate PDF' });
  }
}
