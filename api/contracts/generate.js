// api/contracts/generate.js
import fs from 'fs/promises';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import Handlebars from 'handlebars';
import dayjs from 'dayjs';

// Vercel 함수 런타임 힌트
export const config = { runtime: 'nodejs18.x' };

function resolveLocal(file) {
  // Serverless 패키징 시에도 안전하게 파일을 찾게 하는 유틸
  return new URL(file, import.meta.url);
}

export default async function handler(req, res) {
  // 👇 GET일 때는 절대 무거운 모듈 import/실행하지 않음
  if (req.method === 'GET') {
    res
      .status(200)
      .send('OK: POST JSON to this endpoint to receive a PDF. {lang, customer_name, ...}');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  try {
    // ★ 여기서만 무거운 모듈 로딩 (동적 import)
    const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
      import('@sparticuz/chromium'),
      import('puppeteer-core'),
    ]);

    const lang = (req.body?.lang || 'es').toLowerCase();
    const tplFile = lang === 'ko' ? './template-ko.hbs' : './template-es.hbs';

    // 템플릿 안전 로딩(배포물에 포함되도록 URL 방식)
    const templateUrl = resolveLocal(tplFile);
    const source = await readFile(templateUrl, 'utf8');
    const template = Handlebars.compile(source);

    const data = {
      ...req.body,
      today: dayjs().format('YYYY-MM-DD HH:mm'),
    };

    const html = template(data);

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${Date.now()}.pdf"`);
    res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('GEN_PDF_ERROR', err);
    res.status(500).json({ error: 'GEN_PDF_ERROR', message: String(err?.message || err) });
  }
}
