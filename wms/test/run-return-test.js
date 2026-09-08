/* 반품 실행 북마클릿을 목업에 대고 끝까지 돌려 본다. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

(async () => {
  const url = fs.readFileSync(path.join(__dirname, '..', 'bookmarklet-src', 'run-return.bookmarklet.txt'), 'utf8').trim();
  const code = decodeURIComponent(url.slice('javascript:'.length));

  const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());          // 등록 직전 확인창은 받는다
  await p.goto('http://127.0.0.1:8899/top.html', { waitUntil: 'networkidle' });

  const fail = m => { console.error('실패: ' + m); process.exit(1); };

  await p.evaluate(code);
  if (errs.length) fail('실행 중 오류: ' + errs.join('\n'));
  if (!await p.locator('#__wmsRunBox').isVisible()) fail('진행 상자가 안 뜸');

  const logText = () => p.locator('#__wmsRunBox div[style*="max-height"]').innerText();
  if (!(await logText()).includes('업무 프레임 확인됨')) fail('프레임 확인 실패: ' + await logText());

  await p.locator('#__wmsRunBox button', { hasText: '시작' }).click();
  await p.waitForFunction(() => {
    const t = document.querySelector('#__wmsRunBox').innerText;
    return t.includes('끝 —') || t.includes('멈춤:');
  }, null, { timeout: 30000 });

  const log = await logText();
  if (log.includes('멈춤:')) fail('절차가 중간에 멈춤\n' + log);

  /* 목업이 실제로 각 단계를 받았는지 확인한다.
     6단계 초기화가 목업 상태를 되돌리므로 끝난 뒤의 state 를 보면 안 된다 —
     되돌려지지 않는 처리 기록(로그와 saved)으로 확인한다. */
  const mockLog = await p.frameLocator('#mainFrame').locator('#log').innerText();
  [['2단계 반품등록', '반품등록 완료'],
   ['3단계 반입 처리', '반입 처리 완료'],
   ['4단계 반입내역 조회', '반입내역 3건 조회'],
   ['5단계 입고등록', '입고등록 완료: 3건'],
   ['6단계 초기화', '초기화']].forEach(([what, k]) => {
    if (!mockLog.includes(k)) fail(what + ' 안 됨\n목업 로그: ' + mockLog);
  });
  const mock = await p.frameLocator('#mainFrame').locator('body').evaluate(() => window.__mock);
  if (mock.saved.length !== 1) fail('입고등록 건수가 이상함: ' + JSON.stringify(mock.saved));
  if (mock.saved[0].count !== 3) fail('전체 체크가 안 됨: ' + JSON.stringify(mock.saved[0]));

  // 6단계 — 초기화되고 반품예정번호에 커서
  const focusId = await p.frameLocator('#mainFrame').locator('body').evaluate(() => document.activeElement && document.activeElement.id);
  if (focusId !== 'txtReturnNo') fail('커서가 반품예정번호에 없음: ' + focusId);
  const boxVal = await p.frameLocator('#mainFrame').locator('#txtBoxNo').inputValue();
  if (boxVal !== '') fail('초기화가 안 됨');

  console.log(log);
  console.log('--- 통과: 1~6단계 전부 반영됨, 저장 ' + JSON.stringify(mock.saved) + ' ---');
  await b.close();
})();
