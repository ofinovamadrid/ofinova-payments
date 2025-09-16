// api/contracts/generate.js  (CommonJS)
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;
const path = require('path');
const Handlebars = require('handlebars');
const dayjs = require('dayjs');

/** Vercel 런타임 힌트 */
module.exports.config = { runtime: 'nodejs18.x' };

module.exports = async (req, res) => {
  // 브라우저 GET 접근 시 500 방지
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
    const lang = ((req.body && req.body.lang) || 'es').toLowerCase();
    const tplFile = lang === 'ko' ? 'template-ko.hbs' : 'template-es.hbs';
    const templatePath = path.join(__dirname, tplFile);

    // 템플릿 읽기/컴파일
    const source = await fs.readFile(templatePath, 'utf8');
    const template = Handlebars.compile(source);

    // 템플릿 데이터
    const data = {
      ...(req.body || {}),
      today: dayjs().format('YYYY-MM-DD HH:mm')
    };
    const html = template(data);

    // Puppeteer (Vercel 서버리스 친화 설정)
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true
    });

    await browser.close();

    // PDF 응답
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${Date.now()}.pdf"`);
    res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('GEN_PDF_ERROR', err);
    res.status(500).json({ error: 'GEN_PDF_ERROR', message: String(err && err.message || err) });
  }
};
