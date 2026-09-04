#!/usr/bin/env node
/* 차트 기법 화면이 실제 브라우저에서 도는지 확인한다.
 *
 *   node tools/dev-server.js &
 *   node tools/test-trading-browser.js [주소]
 *
 * playwright 가 없으면 안내만 하고 건너뛴다:  npm i -D playwright
 * 화면 캡처는 SHOT_DIR 환경변수로 둔 폴더에 남긴다(없으면 안 남김).
 */
'use strict';
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('playwright 가 없어 브라우저 점검을 건너뜁니다.  npm i -D playwright');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = (process.argv[2] || process.env.BASE || 'http://localhost:3000/').replace(/\/$/, '') + '/trading';
const SHOT_DIR = process.env.SHOT_DIR || '';
let pass = 0, fail = 0;
const ok = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : '  → ' + (got === undefined ? '' : JSON.stringify(got))));
};
const section = (t) => console.log('\n' + t);
const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name), fullPage: true }); };

// 캔버스에 실제로 무언가 그려졌는지: 배경색이 아닌 픽셀 비율
const inkRatio = (p) => p.evaluate(() => {
  const c = document.querySelector('#chartWrap canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { n++; if (d[i + 3] > 0) ink++; }
  return ink / n;
});
const legendText = (p, id) => p.evaluate((id) => { const el = document.querySelector('.pane-legend[data-pane="' + id + '"]'); return el ? el.textContent : null; }, id);
const checked = (p) => p.$$eval('.tech input[type=checkbox]:checked', (els) => els.map((e) => e.dataset.tech));

async function run() {
  const exe = process.env.CHROMIUM_PATH || undefined;
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const errs = [];
  const hook = (p) => {
    p.on('pageerror', (e) => errs.push(e.message));
    // 종목 불러오기는 바깥 시세 서버가 막혀 있으면 502 를 낸다. 그건 이 점검의 대상이 아니다.
    p.on('console', (m) => { if (m.type() === 'error' && !/api\/stock|status of (502|404|400)/.test(m.text())) errs.push('console: ' + m.text()); });
  };

  // ── PC 화면 ──
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage(); hook(p);
  await p.goto(BASE, { waitUntil: 'networkidle' });

  section('처음 열었을 때');
  ok('제목', (await p.title()) === '차트 기법 보기');
  ok('캔버스가 있다', !!(await p.$('#chartWrap canvas')));
  const techCount = await p.evaluate(() => window.TradingEngine.TECHNIQUES.length);
  ok('기법 체크박스 수 = 기법 목록 수', (await p.$$('.tech input[type=checkbox]')).length === techCount, techCount);
  ok('그룹 4개 (패턴·추세·모멘텀·신호)', (await p.$$('.tgroup')).length === 4);
  ok('패턴 그룹이 맨 위', (await p.$eval('.tgroup', (el) => el.dataset.group)) === 'pattern');
  ok('기본 세트가 켜져 있다 (SMA·거래량·골든크로스)', JSON.stringify(await checked(p)) === JSON.stringify(['sma', 'volume', 'sig_macross']), await checked(p));
  ok('켜진 기법만 파라미터 입력이 보인다', await p.isVisible('.tech[data-tech="sma"] .params') && !(await p.isVisible('.tech[data-tech="rsi"] .params')));
  ok('빈 상태 안내 문구', /데이터가 없습니다/.test(await p.textContent('#status')));
  ok('신호 목록은 비어 있음', await p.isVisible('#sigEmpty'));

  section('샘플 데이터');
  await p.click('#btnSample'); await p.waitForTimeout(300);
  ok('상태줄에 마지막 종가', /마지막 종가/.test(await p.textContent('#status')));
  ok('제목이 샘플 종목', (await p.textContent('#chartTitle')) === '샘플 종목');
  ok('320봉', /320봉/.test(await p.textContent('#chartSub')));
  const ink1 = await inkRatio(p);
  ok('캔버스에 그림이 있다', ink1 > 0.03, ink1);
  const mainLegend = await legendText(p, 'main');
  ok('메인 범례에 시고저종·SMA 값', /시 .*고 .*저 .*종 /.test(mainLegend) && /SMA 5/.test(mainLegend) && /SMA 120/.test(mainLegend), mainLegend);
  ok('거래량 패널 범례', /거래량/.test(await legendText(p, 'volume') || ''));
  const rows1 = (await p.$$('#sigBody tr')).length;
  ok('골든·데드 크로스 신호가 목록에', rows1 > 0, rows1);
  ok('신호 요약 문구', /매수 \d+ · 매도 \d+/.test(await p.textContent('#sigSub')));
  const h1 = await p.evaluate(() => document.querySelector('#chartWrap').offsetHeight);
  ok('차트 높이 = 기본 + 패널 1개', h1 === 480 + 110, h1);
  await shot(p, 'trading-desktop-default.png');

  section('기법 체크 → 차트에 겹침');
  await p.check('.tech input[data-tech="rsi"]'); await p.waitForTimeout(200);
  ok('RSI 켜면 패널 범례가 생긴다', /RSI 14/.test(await legendText(p, 'rsi') || ''), await legendText(p, 'rsi'));
  ok('차트 높이가 패널만큼 늘어남', (await p.evaluate(() => document.querySelector('#chartWrap').offsetHeight)) === 480 + 220);
  ok('RSI 파라미터 입력이 나타남', await p.isVisible('.tech[data-tech="rsi"] .params'));
  await p.check('.tech input[data-tech="bollinger"]'); await p.waitForTimeout(200);
  ok('볼린저 켜면 메인 범례에 상·중·하', /볼린저 상/.test(await legendText(p, 'main')));
  await p.check('.tech input[data-tech="ichimoku"]'); await p.waitForTimeout(200);
  ok('일목균형표 켜면 선행 스팬 값', /선행A/.test(await legendText(p, 'main')));
  const ink2 = await inkRatio(p);
  ok('겹친 만큼 그림이 더 많아짐', ink2 > ink1, [ink1, ink2]);
  await p.check('.tech input[data-tech="sig_rsi"]'); await p.waitForTimeout(200);
  const rows2 = (await p.$$('#sigBody tr')).length;
  ok('신호 기법을 더 켜면 목록이 늘어남', rows2 > rows1, [rows1, rows2]);
  ok('그룹 머리에 켜진 개수', /3개 켜짐/.test(await p.textContent('.tgroup[data-group="trend"] summary')), await p.textContent('.tgroup[data-group="trend"] summary'));
  await shot(p, 'trading-desktop-stacked.png');

  section('패턴 · 매매 전략 → 진입·목표·손절·결과');
  // 샘플 버튼은 매번 다른 데이터를 만드니, 패턴이 들어 있는 고정 데이터로 바꿔 둔다.
  await p.evaluate(() => window.__trading.applyBars(window.TradingEngine.generateSample(320, 7), { name: '샘플 종목', source: '고정 샘플' }));
  await p.click('#btnClear'); await p.waitForTimeout(150);
  await p.check('.tech input[data-tech="pat_three"]'); await p.waitForTimeout(250);
  const stratRows = await p.$$eval('#sigBody tr', (trs) => trs.map((tr) => Array.from(tr.children).map((td) => td.textContent)));
  ok('적삼병·흑삼병 진입 행이 목록에', stratRows.length > 0 && stratRows.every((r) => /적삼병|흑삼병/.test(r[3])), stratRows.slice(0, 2));
  ok('목표가·손절가 칸이 채워짐', stratRows.every((r) => r[5] !== '-' && r[6] !== '-' && /\d/.test(r[5]) && /\d/.test(r[6])), stratRows[0]);
  ok('결과 칸에 목표 도달/손절/만료/진행 중', stratRows.every((r) => /^(★|✕|○|▶) (목표 도달|손절|기간 만료|진행 중)/.test(r[7])), stratRows.map((r) => r[7]));
  ok('요약에 목표 도달률', /전략 \d+건.*목표 도달/.test(await p.textContent('#sigSub')), await p.textContent('#sigSub'));
  const exitInfo = await p.evaluate(() => {
    const st = window.__trading.state.study;
    const exits = st.markers.filter((m) => m.exit);
    return { exits: exits.length, kinds: st.overlays.map((o) => o.kind), first: exits[0] && { index: exits[0].index, type: exits[0].type, entry: exits[0].entryIndex } };
  });
  ok('청산 시점 마커(★✕○)가 차트용으로 생김', exitInfo.exits > 0 && exitInfo.first && exitInfo.first.index > exitInfo.first.entry, exitInfo);
  if (!exitInfo.first) exitInfo.first = { index: 0, entry: 0 };
  ok('패턴 구간·목표/손절 선 overlay', exitInfo.kinds.includes('zones') && exitInfo.kinds.includes('segments'), exitInfo.kinds);
  await p.evaluate((i) => window.__trading.chart.goTo(i), exitInfo.first.index); await p.waitForTimeout(150);
  ok('청산 봉에 가면 범례에 결과 배지', /목표 도달|손절|기간 만료/.test(await legendText(p, 'main')), await legendText(p, 'main'));
  await p.evaluate((i) => window.__trading.chart.goTo(i), exitInfo.first.entry); await p.waitForTimeout(150);
  const entryLegend = await legendText(p, 'main');
  ok('진입 봉 범례에 목표·손절·결과', /진입 · 목표 .* · 손절 .* → /.test(entryLegend), entryLegend);
  await p.selectOption('#sigFilter', 'target'); await p.waitForTimeout(150);
  const tgtRows = await p.$$eval('#sigBody tr', (trs) => trs.map((tr) => tr.lastElementChild.textContent));
  ok('"목표 도달만" 필터', tgtRows.every((t) => /목표 도달/.test(t)), tgtRows);
  await p.selectOption('#sigFilter', 'all');
  await p.check('.tech input[data-tech="pat_cup"]'); await p.check('.tech input[data-tech="strat_bb"]'); await p.waitForTimeout(250);
  ok('컵앤핸들·볼린저 매매를 켜도 오류 없음', errs.length === 0, errs);
  ok('볼린저 매매는 밴드도 같이 그림', /볼린저 상/.test(await legendText(p, 'main')));
  await shot(p, 'trading-desktop-patterns.png');
  await p.click('#btnPreset'); await p.check('.tech input[data-tech="rsi"]'); await p.check('.tech input[data-tech="bollinger"]'); await p.check('.tech input[data-tech="ichimoku"]'); await p.check('.tech input[data-tech="sig_rsi"]'); await p.waitForTimeout(250);

  section('파라미터 바꾸기');
  await p.fill('.tech[data-tech="sma"] input[data-key="periods"]', '10, 50');
  await p.press('.tech[data-tech="sma"] input[data-key="periods"]', 'Tab'); await p.waitForTimeout(200);
  const lg = await legendText(p, 'main');
  ok('SMA 기간을 바꾸면 범례가 따라온다', /SMA 10/.test(lg) && /SMA 50/.test(lg) && !/SMA 120/.test(lg), lg);
  await p.fill('.tech[data-tech="rsi"] input[data-key="period"]', '999');
  await p.press('.tech[data-tech="rsi"] input[data-key="period"]', 'Tab'); await p.waitForTimeout(200);
  ok('범위를 넘는 값은 상한으로 잘림', (await p.inputValue('.tech[data-tech="rsi"] input[data-key="period"]')) === '200');
  ok('패널 이름도 바뀜', /RSI 200/.test(await legendText(p, 'rsi')));

  section('신호 목록 → 차트 이동, 호버');
  const firstRowDate = await p.textContent('#sigBody tr:first-child td:first-child');
  await p.click('#sigBody tr:first-child'); await p.waitForTimeout(900);   // 부드러운 스크롤이 끝날 때까지
  ok('행을 누르면 그 날짜가 범례에', (await legendText(p, 'main')).indexOf(firstRowDate) === 0, [firstRowDate, (await legendText(p, 'main')).slice(0, 12)]);
  ok('그 날의 신호가 범례에 배지로', (await p.$$('.pane-legend[data-pane="main"] .mk')).length > 0);
  const box = await p.$eval('#chartWrap canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await p.mouse.move(box.x + box.w * 0.3, box.y + 100, { steps: 3 }); await p.waitForTimeout(100);
  const hoverA = await legendText(p, 'main');
  await p.mouse.move(box.x + box.w * 0.6, box.y + 100, { steps: 3 }); await p.waitForTimeout(100);
  const hoverB = await legendText(p, 'main');
  ok('마우스를 옮기면 다른 날짜', hoverA.slice(0, 10) !== hoverB.slice(0, 10), [hoverA.slice(0, 10), hoverB.slice(0, 10)]);
  await p.mouse.move(box.x + box.w * 0.6, box.y + 100);
  await p.mouse.wheel(0, -300); await p.waitForTimeout(100);
  const countZoomed = await p.evaluate(() => window.__trading.chart.count);
  ok('휠로 확대하면 보이는 봉 수가 줄어듦', countZoomed < 160, countZoomed);
  await p.click('#zoomAll'); await p.waitForTimeout(100);
  ok('전체 버튼', (await p.evaluate(() => window.__trading.chart.count)) >= 320);
  await p.click('#zoomFit'); await p.waitForTimeout(100);
  ok('최근 버튼', (await p.evaluate(() => window.__trading.chart.count)) === 160);

  section('전체 해제 · 기본 세트 · 저장');
  await p.click('#btnClear'); await p.waitForTimeout(200);
  ok('전체 해제하면 체크 없음', (await checked(p)).length === 0);
  ok('패널 범례가 사라짐', (await legendText(p, 'rsi')) === null && (await legendText(p, 'volume')) === null);
  ok('신호 목록이 빔', await p.isVisible('#sigEmpty'));
  ok('차트 높이가 기본으로', (await p.evaluate(() => document.querySelector('#chartWrap').offsetHeight)) === 480);
  await p.click('#btnPreset'); await p.waitForTimeout(200);
  ok('기본 세트 복원', (await checked(p)).length === 3);
  await p.check('.tech input[data-tech="macd"]'); await p.waitForTimeout(200);
  await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(300);
  ok('새로고침해도 체크가 남는다', (await checked(p)).indexOf('macd') >= 0, await checked(p));
  ok('새로고침해도 데이터가 남는다', (await p.textContent('#chartTitle')) === '샘플 종목');
  ok('바꾼 SMA 기간도 남는다', (await p.inputValue('.tech[data-tech="sma"] input[data-key="periods"]')) === '10, 50');

  section('파일 올리기');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-'));
  const csvPath = path.join(tmp, 'samsung-005930.csv');   // 한글 파일명은 playwright 가 못 올린다(브라우저는 된다)
  let csv = '날짜,종가,대비,등락률,시가,고가,저가,거래량\n';
  let px = 70000;
  for (let i = 60; i >= 1; i--) {
    const d = new Date(Date.UTC(2024, 0, 1)); d.setUTCDate(d.getUTCDate() + i);
    px = Math.round(px * (1 + (Math.sin(i / 5) * 0.02)) / 100) * 100;
    const ds = d.getUTCFullYear() + '.' + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + String(d.getUTCDate()).padStart(2, '0');
    csv += ds + ',"' + px.toLocaleString('en-US') + '",0,0,"' + (px - 300).toLocaleString('en-US') + '","' + (px + 500).toLocaleString('en-US') + '","' + (px - 700).toLocaleString('en-US') + '","' + (1000000 + i * 1000).toLocaleString('en-US') + '"\n';
  }
  fs.writeFileSync(csvPath, csv);
  await p.setInputFiles('#fileInput', csvPath); await p.waitForTimeout(400);
  ok('파일 이름이 제목으로', (await p.textContent('#chartTitle')) === 'samsung-005930', await p.textContent('#chartTitle'));
  ok('60봉 읽음 안내', /60개 봉을 읽었습니다/.test(await p.textContent('#msg')), await p.textContent('#msg'));
  ok('날짜가 오름차순 (첫 봉 2024-01-02)', /2024-01-02 ~/.test(await p.textContent('#chartSub')), await p.textContent('#chartSub'));
  const badPath = path.join(tmp, 'bad.csv');
  fs.writeFileSync(badPath, 'a,b,c\n1,2,3\n');
  await p.setInputFiles('#fileInput', badPath); await p.waitForTimeout(300);
  ok('못 읽는 파일은 오류 안내', /파일을 읽지 못했습니다/.test(await p.textContent('#msg')) && (await p.$eval('#msg', (e) => e.className)) === 'msg err');
  ok('오류가 나도 이전 데이터는 그대로', (await p.textContent('#chartTitle')) === 'samsung-005930');

  section('종목코드 불러오기 (실패 경로)');
  await p.click('#btnFetch'); await p.waitForTimeout(200);
  ok('코드가 비어 있으면 안내', /종목코드를 넣어/.test(await p.textContent('#msg')));
  await p.fill('#symbol', 'AAPL');
  await p.click('#btnFetch');
  await p.waitForFunction(() => document.querySelector('#btnFetch').textContent === '불러오기', null, { timeout: 30000 });
  const m = await p.textContent('#msg');
  ok('서버가 못 가져오면 오류 안내 (또는 성공 안내)', /불러오지 못했습니다|불러왔습니다/.test(m), m);
  ok('버튼이 다시 살아남', !(await p.isDisabled('#btnFetch')));

  ok('페이지 오류 없음', errs.length === 0, errs);
  await ctx.close();

  // ── 휴대폰 화면 ──
  section('휴대폰 화면 (390×844)');
  const mctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage(); hook(mp);
  await mp.goto(BASE, { waitUntil: 'networkidle' });
  await mp.click('#btnSample'); await mp.waitForTimeout(300);
  ok('가로 스크롤 없음', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const cols = await mp.evaluate(() => getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length);
  ok('한 열로 쌓임', cols === 1, cols);
  ok('차트 높이 = 휴대폰 기본 + 패널', (await mp.evaluate(() => document.querySelector('#chartWrap').offsetHeight)) === 340 + 90);
  ok('캔버스에 그림', (await inkRatio(mp)) > 0.03);
  const mbox = await mp.$eval('#chartWrap canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await mp.touchscreen.tap(mbox.x + mbox.w * 0.5, mbox.y + 80); await mp.waitForTimeout(150);
  ok('탭하면 그 봉의 값이 범례에', /^\d{4}-\d{2}-\d{2}/.test(await legendText(mp, 'main')));
  await shot(mp, 'trading-mobile.png');
  ok('휴대폰 화면 오류 없음', errs.length === 0, errs);
  await mctx.close();

  await b.close();
  console.log('\n' + pass + ' 통과, ' + fail + ' 실패');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
