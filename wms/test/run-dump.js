// 덤프 스크립트가 실제 브라우저에서 오류 없이 도는지 확인한다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '01-dump-structure.js'), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text()); });

  await page.goto('http://127.0.0.1:8899/top.html', { waitUntil: 'networkidle' });
  const result = await page.evaluate(src);

  if (errors.length) { console.error('오류 발생:\n' + errors.join('\n')); process.exit(1); }

  const frames = result['프레임'];
  const inner = frames.find(f => (f.title || '') === '도서도매반품');
  const fail = m => { console.error('실패: ' + m); process.exit(1); };

  if (frames.length !== 2) fail('프레임 2개를 찾아야 하는데 ' + frames.length);
  if (!inner) fail('업무 iframe 을 못 찾음');
  if (!inner.tabs.some(t => t.id === 'tab_inout')) fail('탭 수집 실패');
  const ids = inner.inputs.map(i => i.id);
  ['txtReturnNo', 'txtBoxNo', 'txtInBoxNo', 'txtBoxInNo'].forEach(id => {
    if (!ids.includes(id)) fail('입력창 누락: ' + id);
  });
  const boxNo = inner.inputs.find(i => i.id === 'txtBoxNo');
  if (boxNo.label !== '박스번호') fail('라벨 인식 실패: ' + JSON.stringify(boxNo.label));
  if (boxNo.readOnly !== true) fail('readOnly 인식 실패');
  const btnIds = inner.buttons.map(b => b.id);
  ['btnBoxSeq', 'btnReturnReg', 'btnReset', 'btnSaveF6'].forEach(id => {
    if (!btnIds.includes(id)) fail('버튼 누락: ' + id);
  });
  const grid = inner.grids.find(g => g.id === 'tblIn');
  if (!grid || grid.checkboxes !== 3) fail('그리드/체크박스 인식 실패: ' + JSON.stringify(grid));
  if (frames[0].counts.iframe !== 1) fail('상위 프레임 iframe 개수 오류');

  console.log('통과 — 프레임 ' + frames.length + '개, 입력 ' + inner.inputs.length + ', 버튼 ' + inner.buttons.length + ', 탭 ' + inner.tabs.length);
  await browser.close();
})();
