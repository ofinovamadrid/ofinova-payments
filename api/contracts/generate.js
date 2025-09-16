// api/contracts/generate.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs/promises');
const path = require('path');
const dayjs = require('dayjs');

// CJS/ESM 어느 쪽이든 안전하게 handlebars 로드
async function loadHandlebars() {
  try {
    return require('handlebars');
  } catch (_) {
    const mod = await import('handlebars');
    return mod.default || mod;
  }
}

// ✅ config는 exports.config 로 내보내세요 (module.exports를 덮어쓰지 않게)
exports.config = {
  runtime: 'nodejs18.x',
  memory: 1024,
  maxDuration: 60,
};

// 디버그 마커(배포 로그에서 새 파일 적용 확인용)
console.log('USING_CJS_GENERATE_JS');

module.exports = async (req, res) => {
  // 브라우저로 직접 열었을 때 500 방지
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
    const Handlebars = await loadHandlebars();

    // ✅ 템플릿 경로: 지금 파일과 같은 폴더
    const __dirname_local = __dirname;
    const lang = (req.body.lang || 'es').toLowerCase();
    const tplFile = lang === 'ko' ? 'template-ko.hbs' : 'template-es.hbs';
    const templatePath = path.join(__dirname_local, tplFile);

    const source = await fs.readFile(templatePath, 'utf8');
    const template = Handlebars.compile(source);

    const data = { ...req.body, today: dayjs().format('YYYY-MM-DD HH:mm') };
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
};
