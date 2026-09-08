const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '00-mini-dump.js'), 'utf8');
  const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8899/top.html', { waitUntil: 'networkidle' });
  const out = await p.evaluate(src + '\n;window.__D');
  if (errs.length) { console.error('오류: ' + errs.join('\n')); process.exit(1); }
  console.log(out);
  ['txtBoxNo', 'btnBoxSeq', 'tab_inout', '박스번호'].forEach(k => {
    if (!out.includes(k)) { console.error('실패: ' + k + ' 누락'); process.exit(1); }
  });
  console.log('\n--- 통과 ---');
  await b.close();
})();
