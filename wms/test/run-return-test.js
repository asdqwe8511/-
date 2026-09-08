/* 교보 WMS 목업에 대고 1~6단계를 끝까지 돌린다. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

const code = decodeURIComponent(
  fs.readFileSync(path.join(__dirname, '..', 'bookmarklet-src', 'run-return.bookmarklet.txt'), 'utf8').trim()
    .slice('javascript:'.length));

const fail = m => { console.error('실패: ' + m); process.exit(1); };
const log = p => p.locator('#__wmsRunBox div[style*="overflow:auto"]').innerText();

(async () => {
  const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8899/kyobo.html', { waitUntil: 'networkidle' });
  await p.evaluate(code);
  if (errs.length) fail('실행 오류: ' + errs.join('\n'));

  const stat = () => p.locator('#__wmsRunBox div[style*="border-bottom"]').innerText();
  if (!(await stat()).includes('대기 안 함')) fail('처음 상태줄이 틀림: ' + await stat());

  // --- 대기를 안 걸고 채번을 누르면 이유를 말해야 한다 ---
  await p.locator('#mf_wdc_main_subWindow1_wframe_btn_boxNum').click();
  await p.waitForTimeout(600);
  if (!(await log(p)).includes('대기 상태가 아닙니다')) fail('대기 안 걸린 채 눌렀을 때 아무 말이 없음');

  // --- 체크박스를 지정하기 전에는 돌지 않아야 한다 ---
  // 앞서 누른 채번으로 칸에 값이 이미 있다 — 그 값으로 오작동하면 안 된다
  await p.locator('#__wmsRunBox button', { hasText: '대기 시작' }).click();
  if (!(await stat()).includes('대기 중')) fail('대기 상태줄이 안 뜸: ' + await stat());
  await p.waitForTimeout(1200);
  if ((await log(p)).includes('1) 박스번호 채번')) fail('대기를 걸자마자 이미 있던 값으로 돌아버림');

  // 새로 채번하면 그때 돈다
  await p.locator('#mf_wdc_main_subWindow1_wframe_btn_boxNum').click();
  await p.waitForTimeout(1500);
  if (!(await log(p)).includes('전체선택 체크박스를 아직 안 정했습니다')) fail('미지정 상태로 그냥 돌아감');
  await p.locator('#__wmsRunBox button', { hasText: '대기 중지' }).click();

  // --- 집어주기: 반입내역(아래) 그리드의 헤더 체크박스 ---
  await p.locator('#__wmsRunBox button', { hasText: '체크박스 지정' }).click();
  await p.waitForTimeout(400);            // 지정 버튼이 해당 탭을 열어 준다

  // 제 패널의 버튼을 눌러도 그것을 집으면 안 된다 (지난 판에서 실제로 그랬다)
  await p.locator('#__wmsRunBox button', { hasText: '체크박스 지정' }).click();
  await p.waitForTimeout(300);
  if ((await log(p)).includes('__wmsRunBox')) fail('제 패널의 버튼을 집었음\n' + await log(p));

  // 체크박스가 아닌 곳을 눌러도 집으면 안 된다
  await p.locator('#mf_wdc_main_subWindow3_wframe_btn_save').click();
  await p.waitForTimeout(300);
  if (!(await log(p)).includes('여기는 체크박스가 아닙니다')) fail('체크박스가 아닌 것을 걸러내지 못함\n' + await log(p));
  if (await p.locator('.dlg').count()) fail('지정 중에 화면 버튼이 눌려버림');

  await p.locator('#grdInList thead input[type=checkbox]').click();
  await p.waitForTimeout(300);
  const picked = (await log(p)).match(/전체선택 체크박스를 정했습니다: (.+)/);
  if (!picked) fail('집어주기 실패\n' + await log(p));
  if (picked[1].includes('__wmsRunBox')) fail('집은 것이 패널 안 요소: ' + picked[1]);
  console.log('집은 선택자: ' + picked[1]);

  // --- 점검 ---
  await p.locator('#__wmsRunBox button', { hasText: '점검' }).click();
  await p.waitForFunction(() => /전부 찾았습니다|못 찾은 것이/.test(document.querySelector('#__wmsRunBox').innerText), null, { timeout: 20000 });
  const chk = await log(p);
  if (!chk.includes('전부 찾았습니다')) fail('점검에서 빠진 것이 있음\n' + chk);

  // --- 본 작업: 대기를 걸고 화면의 채번 버튼을 사람이 누른다 ---
  await p.locator('#__wmsRunBox button', { hasText: '대기 시작' }).click();
  await p.locator('#mf_wdc_main_nameLayer_mf_wdc_main_subWindow1').click();
  await p.locator('#mf_wdc_main_subWindow1_wframe_btn_boxNum').click();
  /* 로그의 '끝 —' 은 지난 회차 것이 남아 있을 수 있어 기다림의 기준으로 못 쓴다.
     목업이 실제로 저장을 받았는지를 본다. */
  await p.waitForFunction(() => window.__mock.saved.length >= 1 ||
    /멈춤:/.test(document.querySelector('#__wmsRunBox').innerText), null, { timeout: 120000 });
  await p.waitForTimeout(2000);           // 6단계 마무리까지
  const out = await log(p);
  if (out.includes('멈춤:')) fail('중간에 멈춤\n' + out);

  const mockLog = await p.locator('#log').innerText();
  [['2단계 반품등록', '반품등록 완료'], ['3단계 반입등록', '반입등록 완료'],
   ['4단계 반입내역 조회', '반입내역 5건 조회'], ['5단계 입고등록', '입고등록 완료: 5건'],
   ['6단계 초기화', '초기화']].forEach(([w, k]) => {
    if (!mockLog.includes(k)) fail(w + ' 안 됨\n목업: ' + mockLog);
  });

  // 건드리면 안 되는 위쪽 그리드는 그대로여야 한다
  const other = await p.locator('#grdSchd tbody input[type=checkbox]:checked').count();
  if (other !== 0) fail('반품예정 그리드까지 체크됨: ' + other);

  // 확인창을 남기지 않아야 한다
  if (await p.locator('.dlg').count() !== 0) fail('확인창이 남아 있음');

  // 커서는 반품예정번호에
  const focus = await p.evaluate(() => document.activeElement && document.activeElement.id);
  if (focus !== 'mf_wdc_main_subWindow1_wframe_ibx_rtgdSchdNum') fail('커서 위치가 다름: ' + focus);

  if (!out.includes('대기 중 — 박스번호 채번')) fail('한 바퀴 뒤 다시 대기하지 않음\n' + out);
  if (!/(^|\n)\s*5건 체크/.test(out)) fail('첫 실행의 체크 건수 보고가 틀림\n' + out);

  // --- 연달아 돌린다. 대기를 다시 걸 필요 없이 채번만 누르면 돼야 한다. ---
  await p.locator('#mf_wdc_main_subWindow1_wframe_btn_boxNum').click();
  await p.waitForFunction(() => window.__mock.saved.length >= 2 ||
    /멈춤:/.test(document.querySelector('#__wmsRunBox').innerText), null, { timeout: 120000 });
  await p.waitForTimeout(2000);
  const out2 = await log(p);
  if (out2.includes('멈춤:')) fail('두 번째 실행에서 멈춤\n' + out2);
  // 보고한 건수가 실제 저장 건수와 같아야 한다
  if (!/(^|\n)\s*5건 체크/.test(out2)) fail('두 번째 실행의 체크 건수 보고가 틀림\n' + out2);
  // 값이 안 들어온 빈 줄까지 체크하면 안 된다
  const emptyChecked = await p.evaluate(() => [].slice.call(document.querySelectorAll('#tbIn tr'))
    .filter(tr => tr.querySelector('input').checked && !tr.querySelector('.v').textContent).length);
  if (emptyChecked) fail('빈 줄까지 체크됨: ' + emptyChecked + '줄');
  const saved = await p.evaluate(() => window.__mock.saved);
  if (saved.length !== 2) fail('두 번 저장돼야 하는데 ' + JSON.stringify(saved) + '\n2회차 로그:\n' + out2 + '\n상태줄: ' + await stat());
  if (saved[0].box === saved[1].box) fail('두 번 다 같은 박스번호: ' + JSON.stringify(saved));
  saved.forEach(r => { if (r.count !== 5) fail('건수가 다름: ' + JSON.stringify(r)); });

  // 지정한 체크박스는 브라우저에 남아야 한다 — 다음에 또 지정하게 하면 곤란하다
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('__wmsRunCfg') || '{}'));
  if (!kept.chkAll) fail('전체선택 지정이 저장되지 않음');

  console.log('\n' + out2);
  console.log('--- 통과: 연속 2회, 저장 ' + JSON.stringify(saved) + ' ---');
  await b.close();
})();
