/* 녹화 북마클릿: 사람이 손으로 하는 절차를 그대로 따라 하고, 기록이 남는지 본다. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

(async () => {
  const url = fs.readFileSync(path.join(__dirname, '..', 'bookmarklet-src', 'record.bookmarklet.txt'), 'utf8').trim();
  const code = decodeURIComponent(url.slice('javascript:'.length));

  const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.goto('http://127.0.0.1:8899/top.html', { waitUntil: 'networkidle' });

  const fail = m => { console.error('실패: ' + m); process.exit(1); };
  await p.evaluate(code);
  if (errs.length) fail('실행 오류: ' + errs.join('\n'));
  if (!await p.locator('#__wmsRecBox').isVisible()) fail('상자가 안 뜸');

  // 녹화 시작
  await p.locator('#__wmsRecBox button', { hasText: '● 녹화' }).click();

  // ---- 사람이 하는 절차를 흉내 낸다 ----
  const F = p.frameLocator('#mainFrame');
  await F.locator('#btnBoxSeq').click();
  await p.waitForTimeout(700);
  const boxNo = await F.locator('#txtBoxNo').inputValue();
  await F.locator('#btnReturnReg').click();
  await p.waitForTimeout(500);

  await F.locator('#tab_inout').click();
  await F.locator('#txtInBoxNo').fill(boxNo);
  await F.locator('#txtInBoxNo').press('Enter');
  await p.waitForTimeout(700);

  await F.locator('#tab_boxin').click();
  await F.locator('#txtBoxInNo').fill(boxNo);
  await F.locator('#txtBoxInNo').press('Enter');
  await p.waitForTimeout(700);
  await F.locator('#chkAll').click();
  await F.locator('#btnSaveF6').click();
  await p.waitForTimeout(600);

  await F.locator('#tab_return').click();
  await F.locator('#btnReset').click();
  await p.waitForTimeout(400);

  await p.locator('#__wmsRecBox button', { hasText: '■ 정지' }).click();

  const log = await p.locator('#__wmsRecBox div[style*="overflow:auto"]').innerText();
  const need = [
    ['채번 버튼 클릭', '#btnBoxSeq'],
    ['반품등록 클릭', '#btnReturnReg'],
    ['반출입 탭', '#tab_inout'],
    ['반입박스번호 입력', '#txtInBoxNo'],
    ['엔터', '키 Enter'],
    ['박스별입고 탭', '#tab_boxin'],
    ['전체체크', '#chkAll'],
    ['등록 버튼', '#btnSaveF6'],
    ['초기화', '#btnReset'],
    ['프레임 표시', 'top>0:mainFrame'],
    ['라벨 인식', '(반입박스번호)'],
    ['박스번호 값', boxNo],
    ['서버가 채운 값 포착', '화면변화'],
    ['채번 결과 칸', '#txtBoxNo']
  ];
  need.forEach(([what, k]) => { if (!log.includes(k)) fail(what + ' 누락 (' + k + ')\n\n' + log); });

  // 내 상자를 누른 것은 기록되면 안 된다
  if (log.includes('__wmsRecBox')) fail('녹화 상자 자체의 클릭이 기록됨');
  // 버튼에 옆 칸 글자가 라벨로 붙으면 안 된다
  if (/#btnSaveF6[^\n]*\(도서명/.test(log)) fail('버튼에 엉뚱한 라벨이 붙음');
  if (/#btnBoxSeq[^\n]*\(반품예정번호/.test(log)) fail('버튼에 엉뚱한 라벨이 붙음');
  // 한 줄짜리 배치용 표에 줄 번호가 붙으면 안 된다
  if (log.includes('<1/1번째 줄>')) fail('배치용 표에 줄 번호가 붙음');

  // 값 가리기
  await p.locator('#__wmsRecBox input[type=checkbox]').check();
  const masked = await p.locator('#__wmsRecBox div[style*="overflow:auto"]').innerText();
  if (masked.includes(boxNo)) fail('값 가리기가 안 먹음');
  if (!masked.includes('●')) fail('가린 표시가 없음');

  console.log(log.split('\n').slice(0, 24).join('\n'));
  console.log('\n--- 통과: ' + log.split('\n').length + '줄 기록됨 ---');
  await b.close();
})();
