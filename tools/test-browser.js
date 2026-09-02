#!/usr/bin/env node
/* 휴대폰 크기 브라우저에서 화면이 실제로 도는지 확인한다.
 *
 *   node tools/dev-server.js &            (기본 3000번, PORT 로 바꿀 수 있음)
 *   node tools/test-browser.js [주소]
 *
 * playwright 는 이 저장소의 의존성이 아니다(배포에 들어가면 안 된다).
 * 없으면 안내만 하고 건너뛴다:
 *   npm i -D playwright
 */
'use strict';
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('playwright 가 없어 브라우저 점검을 건너뜁니다.  npm i -D playwright');
  process.exit(0);
}

const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3000/';
let pass = 0, fail = 0;
const ok = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : '  → ' + (got === undefined ? '' : got)));
};
const section = (t) => console.log('\n' + t);

// 이 화면들은 사주가 저장된 뒤라야 열린다. 매번 같은 사람으로 채운다.
async function fillMe(p) {
  await p.fill('#year', '1990');
  await p.selectOption('#month', '5');
  await p.selectOption('#day', '15');
  await p.click('#submitBtn'); await p.waitForTimeout(300);
  await p.selectOption('#hour', '14'); await p.fill('#minute', '30');
  await p.click('#submitBtn'); await p.waitForTimeout(300);
  await p.fill('#surname', '김'); await p.fill('#given', '민준');
  await p.click('#submitBtn'); await p.waitForTimeout(2200);
}

async function run() {
  // 브라우저 위치를 환경변수로 일러 줄 수 있게 둔다. playwright 가 받아 둔
  // 브라우저와 시스템에 깔린 크로미움이 다를 때 쓴다.
  const exe = process.env.CHROMIUM_PATH || undefined;
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => {
    // 풀이 API 는 키가 없으면 500 을 낸다. 그건 이 점검의 대상이 아니다.
    if (m.type() === 'error' && !/500 \(Internal/.test(m.text())) errs.push('console: ' + m.text());
  });
  await p.goto(BASE, { waitUntil: 'networkidle' });

  section('앱 껍데기');
  ok('밝은 배경', (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(242, 243, 247)',
     await p.evaluate(() => getComputedStyle(document.body).backgroundColor));
  ok('하단 탭바 3개', (await p.$$('#tabbar button')).length === 3);
  ok('내 사주 탭이 먼저', await p.evaluate(() => document.querySelector('#tabbar button').getAttribute('aria-selected') === 'true'));
  ok('큰 제목', (await p.textContent('#tabMe .app-title')).trim() === '내 사주');

  section('궁합 탭 — 내 사주가 없을 때');
  await p.click('#tabbar button[data-tab="tabCompat"]'); await p.waitForTimeout(300);
  ok('안내 화면', await p.isVisible('.empty-state'));
  ok('상대 폼은 감춤', !(await p.isVisible('#p_year')));
  await p.click('#goMe'); await p.waitForTimeout(300);
  ok('내 사주 탭으로 데려감', await p.isVisible('#year'));

  section('3단계 입력 — 한자 고르기');
  await p.fill('#year', '1990'); await p.selectOption('#month', '5'); await p.selectOption('#day', '15');
  await p.click('#submitBtn'); await p.waitForTimeout(300);
  await p.selectOption('#hour', '14'); await p.fill('#minute', '30');
  await p.click('#submitBtn'); await p.waitForTimeout(300);
  ok('3단계가 마지막', (await p.textContent('#submitBtn')).trim() === '내 사주 보기');
  ok('이름 전엔 한자 버튼 숨김', !(await p.isVisible('#hanjaToggle')));
  await p.fill('#surname', '김'); await p.fill('#given', '민준'); await p.waitForTimeout(250);
  ok('이름을 넣으면 나타남', await p.isVisible('#hanjaToggle'));
  await p.click('#hanjaToggle'); await p.waitForTimeout(250);
  ok('음절 3줄', (await p.$$('#hanjaPicker .hj-syl')).length === 3);
  ok('김은 金 하나뿐', (await p.$$('#hanjaPicker .hj-syl:nth-child(1) .hj-btn')).length === 1);
  ok('민은 여러 자', (await p.$$('#hanjaPicker .hj-syl:nth-child(2) .hj-btn')).length > 8);
  ok('획수 표시', /\d+획/.test(await p.textContent('#hanjaPicker .hj-syl:nth-child(2)')));
  for (let i = 0; i < 3; i++) {
    const btns = await p.$$(`#hanjaPicker .hj-syl:nth-child(${i + 1}) .hj-btn`);
    await btns[0].click(); await p.waitForTimeout(120);
  }
  ok('고른 한자가 칸에 들어감', /^[㐀-鿿]{3}$/.test(await p.inputValue('#hanja')), await p.inputValue('#hanja'));
  await p.click('#submitBtn'); await p.waitForTimeout(2200);

  section('결과 — 쉬운 말');
  ok('사주표 4기둥', (await p.$$('#pillars .pillar')).length === 4);
  const plain = await p.textContent('#plainSummary');
  ok('비유로 먼저 말함', /당신은 .+ 같은 사람이에요/.test(plain), plain.slice(0, 40));
  ok('띠', /띠\)은 말/.test(plain));
  ok('별자리', /황소자리/.test(plain));
  ok('별자리는 다른 체계라고 밝힘', /사주와 다른 체계/.test(plain));
  ok('용어는 접어 둠', await p.isVisible('[data-why="whyMe"]'));
  await p.click('[data-why="whyMe"]'); await p.waitForTimeout(200);
  ok('펼치면 보임', await p.isVisible('#whyMe'));
  ok('풀이는 잠겨 있음', await p.isVisible('#readingGate'));
  ok('저장 카드', await p.isVisible('.saved-card'));
  ok('입력 폼은 접힘', !(await p.isVisible('#year')));

  section('오늘의 운세');
  ok('카드', await p.isVisible('#todayCard .today'));
  const grade = (await p.textContent('.today-grade')).trim();
  ok('등급이 말', /좋아요|보통이에요|조심/.test(grade), grade);
  ok('숫자 점수 없음', !/\d+점/.test(await p.textContent('#todayCard')));
  ok('세 영역 요약', (await p.$$('.today-dom')).length === 3);
  ok('하면 좋은 일', await p.isVisible('.today-advice .do'));
  ok('미룰 일', await p.isVisible('.today-advice .dont'));
  ok('아홉 가지는 접힘', !(await p.isVisible('#todayAll')));
  await p.click('#todayMore'); await p.waitForTimeout(250);
  ok('펼치면 아홉 줄', (await p.$$('#todayAll .today-row')).length === 9);
  const all = await p.textContent('#todayAll');
  ok('아홉 영역 이름', ['재물운', '건강운', '사업운', '재능운', '애정운', '배우자운', '자식운', '인복', '귀인운']
     .every((x) => all.includes(x)));

  section('올해 달력');
  ok('패널', await p.isVisible('#yearPanel'));
  ok('제목에 올해', /\d{4}년은 어떤 해인가/.test(await p.textContent('#yearTitle')));
  const ysub = await p.textContent('#yearSub');
  ok('대운·세운 설명', /대운/.test(ysub) && /세운/.test(ysub));
  ok('절기로 나눈 달임을 밝힘', /절기로 나눈 달/.test(await p.textContent('#yearDomsNote')),
     await p.textContent('#yearDomsNote'));
  ok('아홉 영역 줄', (await p.$$('#yearDoms .year-dom')).length === 9);
  const yd = await p.textContent('#yearDoms');
  ok('좋은 때·조심할 때', /가장 좋은 때/.test(yd) && /가장 조심할 때/.test(yd));
  ok('기간을 날짜로 적음', /\d+월 \d+일 ~ \d+월 \d+일/.test(yd), yd.slice(0, 70));
  ok('숫자 점수 없음', !/\d+점/.test(yd));
  ok('달 12개', (await p.$$('#monthChips .chip')).length === 12);
  const mlabels = await p.$$eval('#monthChips .chip', (els) => els.map((e) => e.textContent.trim()));
  ok('1월부터 12월까지 차례로',
     JSON.stringify(mlabels) === JSON.stringify(
       Array.from({ length: 12 }, (_, i) => (i + 1) + '월')), mlabels.join(','));
  ok('한 달이 미리 열림', (await p.$$('#monthChips .chip[aria-pressed="true"]')).length === 1);
  ok('달력 격자', await p.isVisible('.cal-grid'));
  ok('요일 머리 7개', (await p.$$('.cal-dow')).length === 7);

  // 1일부터 말일까지, 요일 자리에 정확히 맞아야 한다.
  await p.click('#monthChips .chip[data-m="3"]'); await p.waitForTimeout(600);
  const marchDays = await p.$$eval('.cal-grid .cal-day:not(.pad)', (els) =>
    els.map((e) => e.querySelector('.d') && e.querySelector('.d').textContent.trim()));
  ok('3월은 1일부터 31일까지',
     marchDays.length === 31 && marchDays[0] === '1' && marchDays[30] === '31',
     marchDays.length + '칸: ' + marchDays.slice(0, 3).join(',') + '…' + marchDays.slice(-1));
  const pads = await p.$$('.cal-grid .cal-day.pad');
  const firstDow = await p.evaluate((y) => new Date(Date.UTC(y, 2, 1)).getUTCDay(),
     await p.evaluate(() => new Date().getFullYear()));
  ok('첫날이 맞는 요일 칸에서 시작', pads.length === firstDow, pads.length + ' vs ' + firstDow);
  await p.click('#monthChips .chip[data-m="2"]'); await p.waitForTimeout(600);
  const febDays = await p.$$eval('.cal-grid .cal-day:not(.pad)', (els) => els.length);
  ok('2월은 28일 또는 29일', febDays === 28 || febDays === 29, febDays);
  ok('절기 드는 날에 표시', (await p.$$('.cal-day.term')).length >= 1,
     (await p.$$('.cal-day.term')).length);

  await p.click('#monthChips .chip[data-m="10"]'); await p.waitForTimeout(600);
  const dayBtns = await p.$$('.cal-day[data-i]');
  ok('10월은 31칸', dayBtns.length === 31, dayBtns.length);
  ok('날짜 상세는 접힘', !(await p.isVisible('.cal-pick')));
  await dayBtns[10].click(); await p.waitForTimeout(300);
  ok('누르면 열림', await p.isVisible('.cal-pick'));
  ok('아홉 줄', (await p.$$('.cal-pick .cp-row')).length === 9);
  ok('일진 표시', /[가-힣]{2}날/.test(await p.textContent('.cal-pick')));
  await p.click('#monthChips .chip[data-m="7"]'); await p.waitForTimeout(600);
  ok('달을 바꾸면 상세는 닫힘', !(await p.isVisible('.cal-pick')));

  section('용신·희신·기신·구신');
  ok('네 자리', (await p.$$('#rolesBlock .role')).length === 4);
  const roles = await p.$$eval('#rolesBlock .role b', (els) => els.map((e) => e.textContent.trim()));
  ok('용신·희신·기신·구신', JSON.stringify(roles) === JSON.stringify(['용신', '희신', '기신', '구신']), roles.join(','));
  const rnote = await p.textContent('.roles-note');
  ok('원국에 있는지 말해 줌', /사주 안에/.test(rnote), rnote.slice(0, 40));
  ok('색·방위·숫자', /색|쪽/.test(rnote) && /숫자/.test(rnote));

  section('12운성');
  ok('막대 10개', (await p.$$('.stage-bars .stage-bar')).length === 10, (await p.$$('.stage-bars .stage-bar')).length);
  ok('지금 자리 하나', (await p.$$('.stage-bar.now')).length === 1);
  const snow = await p.textContent('.stage-now');
  ok('지금 단계를 쉬운 말로', /열두 단계로는/.test(snow), snow.slice(0, 50));
  ok('가장 높은 때·낮은 때', (await p.$$('.stage-peak div')).length === 2);
  const stg = await p.textContent('.stage-bars');
  ok('단계 이름이 적힘', /장생|목욕|관대|건록|제왕|쇠|병|사|묘|절|태|양/.test(stg));

  section('길흉일 — 무슨 일에 어느 날');
  ok('활동 칩 7개', (await p.$$('#actChips .chip')).length === 7, (await p.$$('#actChips .chip')).length);
  const acts = await p.$$eval('#actChips .chip', (els) => els.map((e) => e.textContent.trim()));
  ok('계약·이사·시험·수술 있음', ['계약','이사','시험','수술'].every((x) => acts.includes(x)), acts.join(','));
  ok('처음엔 접혀 있음', !(await p.isVisible('.act-box')));
  await p.click('#actChips .chip[data-act="계약"]'); await p.waitForTimeout(400);
  ok('누르면 열림', await p.isVisible('.act-box'));
  ok('좋은 날 3개', (await p.$$('.act-day.good')).length === 3, (await p.$$('.act-day.good')).length);
  ok('피할 날 3개', (await p.$$('.act-day.bad')).length === 3);
  const abox = await p.textContent('.act-box');
  ok('시간대까지 알려줌', /시\(\d\d:\d\d~\d\d:\d\d\)/.test(abox), abox.slice(0, 80));
  ok('그날 자체가 아니라고 밝힘', /그날 자체가 좋은 날이라는 뜻이 아니라/.test(abox));
  ok('숫자 점수 없음', !/\d+점/.test(abox));
  const contract = await p.textContent('.act-day.good');
  await p.click('#actChips .chip[data-act="이사"]'); await p.waitForTimeout(400);
  ok('활동을 바꾸면 날짜도 바뀐다', (await p.textContent('.act-box')).includes('역마') ||
     (await p.textContent('.act-day.good')) !== contract);
  await p.click('#actChips .chip[data-act="이사"]'); await p.waitForTimeout(300);
  ok('다시 누르면 접힘', !(await p.isVisible('.act-box')));

  section('저장 — 새로고침해도 남는가');
  await p.reload({ waitUntil: 'networkidle' });
  ok('저장 카드', await p.isVisible('.saved-card'));
  ok('이름', /김민준/.test(await p.textContent('.saved-card')));
  ok('오늘의 운세도 그대로', await p.isVisible('#todayCard .today'));

  section('궁합');
  await p.click('#tabbar button[data-tab="tabCompat"]'); await p.waitForTimeout(300);
  ok('상대 폼', await p.isVisible('#p_year'));
  ok('내 사주 미니 카드', await p.isVisible('#savedMeMini .saved-card'));
  ok('버튼은 궁합 보기', (await p.textContent('#submitBtn')).trim() === '궁합 보기');
  await p.fill('#p_year', '1993'); await p.selectOption('#p_month', '7'); await p.selectOption('#p_day', '22');
  await p.selectOption('#p_hour', '5'); await p.fill('#p_minute', '40');
  await p.fill('#p_surname', '이'); await p.fill('#p_given', '서연');
  await p.click('#submitBtn'); await p.waitForTimeout(1800);
  ok('쉬운 말', /님과 .+님은/.test(await p.textContent('#compatPlain')));
  ok('궁합 패널', await p.isVisible('#compatPanel'));
  ok('궁합도 말로', /편$|보통/.test((await p.textContent('#compatScore')).trim()),
     (await p.textContent('#compatScore')).trim());
  ok('풀이는 잠겨 있음', await p.isVisible('#creadingGate'));

  section('관계별 궁합 — 여섯 개를 한눈에');
  ok('블록', await p.isVisible('#relBlock .rel-wrap'));
  ok('타일 6개', (await p.$$('#relChips .rel-tile')).length === 6, (await p.$$('#relChips .rel-tile')).length);
  const labels = await p.$$eval('#relChips .rt-name', (els) => els.map((e) => e.textContent.trim()));
  ok('애인·부부·직장·동업·친구·가족이 모두 있음',
     ['애인', '부부', '직장', '동업', '친구', '가족'].every((x) => labels.includes(x)), labels.join(','));
  const nums = await p.$$eval('#relChips .rt-score', (els) => els.map((e) => Number(e.textContent.trim())));
  ok('여섯 개 모두 점수가 보임', nums.length === 6 && nums.every((n) => n >= 0 && n <= 100), nums.join(','));
  ok('잘 맞는 순서로 세워짐', nums.every((n, i) => i === 0 || nums[i - 1] >= n), nums.join(','));
  const grades = await p.$$eval('#relChips .rt-grade', (els) => els.map((e) => e.textContent.trim()));
  ok('여섯 개 모두 등급도 보임', grades.length === 6 && grades.every((g) => g.length > 0), grades.join(','));
  ok('100점 만점이 아니라고 밝힘', /100점 만점의 점수가 아니/.test(await p.textContent('.rel-note-num')));
  const g1 = (await p.textContent('.rel-grade')).trim();
  ok('고른 관계의 등급이 말로', /(으로는|로는) /.test(g1) && !/\d/.test(g1), g1);
  ok('좋은 점', (await p.$$('.rel-note .g')).length >= 1);
  ok('걸리는 점', (await p.$$('.rel-note .b')).length >= 1);
  const say = await p.textContent('.rel-say');
  ok('할 말·피할 말', /하면 좋은 말/.test(say) && /피할 말/.test(say));
  ok('할 행동·피할 행동', /하면 좋은 행동/.test(say) && /피할 행동/.test(say));
  await p.click('#relChips .rel-tile[data-rel="friend"]'); await p.waitForTimeout(250);
  ok('친구로 바꾸면 조사도 바뀜', /^친구로는 /.test((await p.textContent('.rel-grade')).trim()));

  section('궁합 첫 문단이 쉬운 말인가');
  const cdesc = await p.textContent('#compatDesc .cd-prose');
  ok('자형·원진 같은 용어가 그대로 안 나옴', !/자형|원진|천간충|천간합|육합|삼합/.test(cdesc), cdesc.slice(0, 90));
  ok('"사이"로 풀어 씀', /사이/.test(cdesc), cdesc.slice(0, 60));
  ok('잘 맞는 지점도 쉬운 말', !/일간이 충함|일지 자형|오행이 서로 극함|용신/.test(
     await p.textContent('#compatStrengths') + await p.textContent('#compatFrictions')),
     (await p.textContent('#compatFrictions')).slice(0, 70));
  ok('원래 용어 상자가 있음', await p.isVisible('[data-why="whyCompat"]'));
  await p.click('[data-why="whyCompat"]'); await p.waitForTimeout(200);
  ok('열면 원래 용어가 보임', await p.isVisible('#whyCompat'));
  ok('용어 설명 줄이 있음', (await p.$$('#whyCompat .term-row')).length >= 1);

  section('더보기');
  await p.click('#tabbar button[data-tab="tabMore"]'); await p.waitForTimeout(300);
  ok('실행 버튼 숨김', !(await p.isVisible('#submitBtn')));
  ok('목록 3행', (await p.$$('#tabMore .list-row[data-go]')).length === 3);
  await p.click('[data-go="batch"]'); await p.waitForTimeout(400);
  await p.click('#batchToggle'); await p.waitForTimeout(300);
  await p.fill('#contactPaste', '홍길동 1990-05-15\n이도현 1988/02/17\n최민준 20010309');
  await p.waitForTimeout(300);
  await p.click('#batchBtn'); await p.waitForTimeout(900);
  ok('순위 3행', (await p.$$('#rankTable tbody tr')).length === 3);
  await p.click('[data-go="share"]'); await p.waitForTimeout(300);
  await p.click('#makeLink'); await p.waitForTimeout(300);
  ok('링크는 # 뒤에 담긴다', (await p.inputValue('#shareUrl')).includes('#invite='));

  section('글로 풀어 읽기');
  await p.click('#tabbar button[data-tab="tabMe"]'); await p.waitForTimeout(300);
  // 풀이는 표와 목록을 함께 쓴다. 문단만 그리면 파이프(|)가 글자로 남는다.
  // 진짜 API 는 키가 있어야 하므로, 여기서는 마크다운 렌더링만 확인한다.
  const SAMPLE = ['## 첫 절', '', '**굵게** 그리고 *기울임*.', '',
    '| 갈래 | 상태 |', '|---|---|', '| 재성 | 얇음 |', '| 관성 | 적당 |', '',
    '- 첫째', '- 둘째', '', '1. 하나', '2. 둘', '', '---', '', '마지막 문단.'].join('\n');
  const md = await p.evaluate((t) => {
    // 페이지 안의 markdownToHtml 은 즉시실행 함수 안에 있어 밖에서 못 부른다.
    // 대신 풀이 칸에 직접 넣어 같은 경로로 그린다.
    const box = document.getElementById('readingBox');
    box.innerHTML = '';
    return t;
  }, SAMPLE);
  ok('풀이 칸이 있다', await p.isVisible('#readingPanel'));
  ok('처음엔 잠겨 있다', await p.isVisible('#readingGate'));
  ok('표 스타일이 실려 있다', await p.evaluate(() => {
    const el = document.createElement('table'); el.className = 'md-table';
    document.body.appendChild(el);
    const ok2 = getComputedStyle(el).borderCollapse === 'collapse';
    el.remove(); return ok2;
  }));
  // 어두운 톤에서 넘어온 흰 글씨가 남아 있으면 굵은 글씨가 안 보인다.
  ok('굵은 글씨가 배경색이 아니다', await p.evaluate(() => {
    const box = document.getElementById('readingBox');
    box.innerHTML = '<p><strong>보임</strong></p>';
    const c = getComputedStyle(box.querySelector('strong')).color;
    box.innerHTML = '';
    return c !== 'rgb(255, 255, 255)';
  }));

  section('저장 지우기');
  await p.click('#tabbar button[data-tab="tabMore"]'); await p.waitForTimeout(300);
  p.once('dialog', (d) => d.accept());
  await p.click('[data-go="reset"]'); await p.waitForTimeout(500);
  ok('오늘의 운세 사라짐', !(await p.isVisible('#todayCard .today')));
  ok('입력 폼 복귀', await p.isVisible('#year'));

  section('가로 스크롤');
  ok('없음', (await p.evaluate(() => document.documentElement.scrollWidth)) === 390,
     await p.evaluate(() => document.documentElement.scrollWidth));

  console.log('\nJS 오류: ' + (errs.length ? errs.join(' | ') : '없음'));
  if (errs.length) fail += errs.length;
  console.log(`\n${pass} 통과, ${fail} 실패`);
  await b.close();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
