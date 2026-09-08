/* 만들어진 즐겨찾기 주소를 실제로 해독해 실행하고, 화면에 상자가 뜨는지 본다. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

(async () => {
  const url = fs.readFileSync(path.join(__dirname, '..', 'bookmarklet-src', 'dump.bookmarklet.txt'), 'utf8').trim();
  if (!url.startsWith('javascript:')) { console.error('실패: javascript: 로 시작하지 않음'); process.exit(1); }
  const code = decodeURIComponent(url.slice('javascript:'.length));

  const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8899/top.html', { waitUntil: 'networkidle' });

  await p.evaluate(code);
  if (errs.length) { console.error('오류: ' + errs.join('\n')); process.exit(1); }

  const fail = m => { console.error('실패: ' + m); process.exit(1); };
  if (!await p.locator('#__wmsDumpBox').isVisible()) fail('상자가 안 뜸');
  const text = await p.locator('#__wmsDumpBox textarea').inputValue();
  ['txtBoxNo', 'btnBoxSeq', 'tab_inout', '반품예정번호', 'mainFrame'].forEach(k => {
    if (!text.includes(k)) fail('내용 누락: ' + k);
  });

  // 두 번 눌러도 상자가 겹치지 않아야 한다
  await p.evaluate(code);
  if (await p.locator('#__wmsDumpBox').count() !== 1) fail('두 번 실행하면 상자가 겹침');

  // 복사 버튼이 눌리고 안내 문구가 바뀌는지
  await p.locator('#__wmsDumpBox button', { hasText: '전체 복사' }).click();
  const label = await p.locator('#__wmsDumpBox button').first().textContent();
  if (label === '전체 복사') fail('복사 버튼이 반응 없음');

  // 닫기
  await p.locator('#__wmsDumpBox button', { hasText: '닫기' }).click();
  if (await p.locator('#__wmsDumpBox').count() !== 0) fail('닫기가 안 됨');

  // 화면을 건드리지 않았는지 — 입력값과 활성 탭이 그대로여야 한다
  const boxVal = await p.frameLocator('#mainFrame').locator('#txtBoxNo').inputValue();
  if (boxVal !== '') fail('입력값이 바뀜: ' + boxVal);

  console.log('통과 — 주소 ' + url.length.toLocaleString() + '자, 덤프 ' + text.split('\n').length + '줄');
  await b.close();
})();
