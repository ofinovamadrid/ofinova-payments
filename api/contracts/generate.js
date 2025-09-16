// api/contracts/generate.js
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import dayjs from 'dayjs';

// Vercel 함수 런타임/리소스 힌트
export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  // 브라우저에서 GET으로 열었을 때 500 방지
  if (req.method === 'GET') {
    res
      .status(200)
      .send('OK: POST JSON to this endpoint to receive a PDF. Example fields: { lang, customer_name, ... }');
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const lang = (req.body.lang || 'es').toLowerCase();
    const tplFile = lang === 'ko' ? 'template-ko.hbs' : 'template-es.hbs';
    const templatePath = path.join(__dirname, tplFile);

    // 핸들바 템플릿 로드
    const source = await fs.readFile(templatePath, 'utf8');
    const template = Handlebars.compile(source);

    // 템플릿 데이터 구성
    const data = {
      ...req.body,
      today: dayjs().format('YYYY-MM-DD HH:mm')
    };

    const html = template(data);

    // Chromium (Vercel 서버리스용)
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    // PDF 전송
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${Date.now()}.pdf"`);
    res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('GEN_PDF_ERROR', err);
    res.status(500).json({ error: 'GEN_PDF_ERROR', message: String(err?.message || err) });
  }
}
