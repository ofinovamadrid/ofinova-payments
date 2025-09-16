// api/contracts/generate.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs/promises');
const path = require('path');
const dayjs = require('dayjs');
const Handlebars = require('handlebars');

// 함수 리소스 힌트
exports.config = {
  runtime: 'nodejs18.x',
  memory: 1024,
  maxDuration: 60
};

// 디버그 마커(로그에서 새 배포 확인)
console.log('USING_CJS_GENERATE_JS');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    res
      .status(200)
      .send('OK: POST JSON to this endpoint to receive a PDF. Example: { "lang":"es","customer_name":"..." }');
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  try {
    // 템플릿은 현재 파일과 같은 폴더(api/contracts)에 있다고 가정
    const lang = ((req.body.lang || 'es') + '').toLowerCase();
    const tplFile = lang === 'ko' ? 'template-ko.hbs' : 'template-es.hbs';
    const templatePath = path.join(__dirname, tplFile);

    const source = await fs.readFile(templatePath, 'utf8');
    const template = Handlebars.compile(source);

    const data = { ...req.body, today: dayjs().format('YYYY-MM-DD HH:mm') };
    const html = template(data);

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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${Date.now()}.pdf"`);
    res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('GEN_PDF_ERROR', err);
    res.status(500).json({ error: 'GEN_PDF_ERROR', message: String(err?.message || err) });
  }
};
