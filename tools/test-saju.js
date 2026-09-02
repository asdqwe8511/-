#!/usr/bin/env node
// saju-engine.js 자체 점검. 알려진 값과 맞는지 확인한다.
//   node tools/test-saju.js
const E = require('../saju-engine.js');

let pass = 0, fail = 0;
function ok(label, got, want) {
  const good = String(got) === String(want);
  good ? pass++ : fail++;
  console.log((good ? '  ✓ ' : '  ✗ ') + label + (good ? '' : `  got=${got} want=${want}`));
}
function section(t) { console.log('\n' + t); }

const gz = (p) => p ? E.STEM[p.stem] + E.BRANCH[p.branch] : '-';
const chart = (y, m, d, h, opt) =>
  E.buildChart(Object.assign({ year: y, month: m, day: d, hour: h, minute: 0 }, opt || {}));

section('절기 시각 (한국 표준시)');
const kst = (jd) => {
  const t = E.fromJD(jd + 9 / 24), hh = Math.floor(t.hour), mm = Math.round((t.hour - hh) * 60);
  return `${t.m}/${t.d} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
ok('2024 입춘', kst(E.solveSolarLongitude(315, E.toJD(2024, 2, 4, 0))), '2/4 17:27');
ok('2024 하지', kst(E.solveSolarLongitude(90,  E.toJD(2024, 6, 21, 0))), '6/21 05:51');
ok('2024 동지', kst(E.solveSolarLongitude(270, E.toJD(2024, 12, 21, 0))), '12/21 18:20');

section('일주 (60갑자 기준점)');
ok('1949-10-01', gz(chart(1949, 10, 1, 12).pillars.day), '갑자');
ok('2000-01-01', gz(chart(2000, 1, 1, 12).pillars.day), '무오');

section('연주 — 입춘 기준으로 넘어가는가');
ok('2024-01-15 (입춘 전)', gz(chart(2024, 1, 15, 12).pillars.year), '계묘');
ok('2024-02-10 (입춘 후)', gz(chart(2024, 2, 10, 12).pillars.year), '갑진');
ok('2000-06-01', gz(chart(2000, 6, 1, 12).pillars.year), '경진');

section('월주 — 오호둔');
ok('2024-03-15 (갑진년 묘월)', gz(chart(2024, 3, 15, 10).pillars.month), '정묘');

section('시지 — 자시는 23시부터, 두 시간 단위');
const want = ['자','축','축','인','인','묘','묘','진','진','사','사','오','오','미','미','신','신','유','유','술','술','해','해','자'];
let hourOk = true;
for (let h = 0; h < 24; h++) {
  const b = E.BRANCH[chart(2024, 6, 10, h, { useSolarTime: false }).pillars.hour.branch];
  if (b !== want[h]) { hourOk = false; console.log(`    ${h}시 → ${b} (기대 ${want[h]})`); }
}
ok('0~23시 전부', hourOk, true);

section('시간(天干) — 오자둔');
// 을·경일의 자시는 병자시 (오자둔: 갑기-갑자, 을경-병자, 병신-무자, 정임-경자, 무계-임자)
ok('을일 자시 → 병자시', (() => {
  const c = chart(2024, 6, 10, 0, { useSolarTime: false });
  return E.STEM[c.pillars.day.stem] + '일 ' + gz(c.pillars.hour) + '시';
})(), '을일 병자시');
ok('갑일 자시 → 갑자시', (() => {
  const c = chart(2024, 6, 9, 0, { useSolarTime: false });   // 갑진일
  return E.STEM[c.pillars.day.stem] + '일 ' + gz(c.pillars.hour) + '시';
})(), '갑일 갑자시');

section('음력 — 알려진 명절');
const holidays = [
  [2020, 1, 25, '1/1'], [2023, 1, 22, '1/1'], [2024, 2, 10, '1/1'], [2025, 1, 29, '1/1'],
  [2020, 10, 1, '8/15'], [2023, 9, 29, '8/15'], [2024, 9, 17, '8/15'],
  [2024, 5, 15, '4/8'], [2023, 5, 27, '4/8'],
  [2020, 5, 23, '윤4/1'], [2023, 3, 22, '윤2/1'], [2017, 6, 24, '윤5/1']
];
holidays.forEach(([y, m, d, w]) => {
  const l = E.solarToLunar(y, m, d);
  ok(`${y}-${m}-${d}`, (l.leap ? '윤' : '') + l.month + '/' + l.day, w);
});

section('윤달이 있는 해');
[[2017, 5], [2020, 4], [2023, 2], [2025, 6], [1987, 6]].forEach(([y, m]) => {
  ok(`${y}년`, E.leapMonthsOf(y).join(','), String(m));
});

section('양력 ↔ 음력 왕복 (1930~2026, 7일 간격)');
let bad = 0, n = 0;
for (let i = 0; i < 5000; i++) {
  const t = E.fromJD(Math.floor(E.toJD(1930, 1, 1, 12)) + i * 7);
  n++;
  const l = E.solarToLunar(t.y, t.m, t.d);
  const b = l && E.lunarToSolar(l.year, l.month, l.day, l.leap);
  if (!b || b.error || b.year !== t.y || b.month !== t.m || b.day !== t.d) bad++;
}
ok(`${n}일 전부 왕복 일치`, bad, 0);

section('오행 관계');
ok('목생화', E.generates('목', '화'), true);
ok('목극토', E.controls('목', '토'), true);
ok('수생목', E.generates('수', '목'), true);

section('용신 — 신약이면 인성·비겁, 신강이면 식상·재·관');
const weak = E.fullReading({ calendar: '양력', year: 1993, month: 7, day: 22, hour: 5, minute: 40, gender: '여' });
ok('갑목 신약', weak.analysis.strength.indexOf('신약') >= 0, true);
ok('용신에 수·목', weak.analysis.yongsin.join(','), '수,목');

section('성명학');
const nm = E.analyzeName('김', '서연', { yongsin: ['수', '목'], missing: [], excess: [] });
ok('김 획수', nm.syllables[0].strokes, 5);
ok('김 초성 오행', nm.syllables[0].elem, '목');
ok('정격 = 전체 획수', nm.frames[3].num, nm.strokes.total);
const solo = E.analyzeName('강', '민', {});
ok('외자 이름 가상수', solo.strokes.virtualNumberUsed, true);

section('운세 시기 — 점수와 구간');
const fr = E.fullReading({ calendar: '양력', year: 1990, month: 5, day: 15, hour: 14, minute: 30, gender: '남' });
const F = E.fortuneTimeline(fr, { fromAge: 30, toAge: 60 });
ok('연도 91개(만 0~90세)', F.years.length, 91);
ok('점수는 0~100', F.years.every((y) => ['money','health','relation'].every((k) => y[k] >= 0 && y[k] <= 100)), true);
['money', 'health', 'relation'].forEach((k) => {
  const d = F.domains[k];
  ok(d.label + ' 좋은 시기 3개', d.best.length, 3);
  ok(d.label + ' 조심할 시기 3개', d.worst.length, 3);
  ok(d.label + ' 좋은 시기가 조심할 시기보다 높은 점수',
     Math.min.apply(null, d.best.map((p) => p.score)) > Math.max.apply(null, d.worst.map((p) => p.score)), true);
  // 구간이 서로 겹치면 같은 해를 두 번 세는 것이다
  const spans = d.best.concat(d.worst);
  let overlap = false;
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].fromYear <= spans[j].toYear && spans[j].fromYear <= spans[i].toYear) overlap = true;
    }
  }
  ok(d.label + ' 구간끼리 겹치지 않음', overlap, false);
  ok(d.label + ' 구간이 지정한 창 안에 있음',
     spans.every((p) => p.fromAge >= 30 && p.toAge <= 60), true);
});

section('지지 관계');
ok('자오 충', E.branchRelations(0, 6).some((r) => r.name === '충'), true);
ok('인해 육합', E.branchRelations(2, 11).some((r) => r.name === '육합'), true);
ok('인오술 삼합', E.branchRelations(2, 6).some((r) => r.name === '삼합'), true);
ok('인사신 삼형', E.branchRelations(2, 5).some((r) => r.name === '형'), true);
ok('진진 자형', E.branchRelations(4, 4).some((r) => r.name === '자형'), true);
ok('갑기 천간합', E.stemRelation(0, 5).name, '천간합');
ok('갑경 천간충', E.stemRelation(0, 6).name, '천간충');

section('궁합 — 구조');
const cA = E.fullReading({ calendar: '양력', year: 1990, month: 5, day: 15, hour: 14, minute: 30, gender: '남', surname: '김', given: '민준' });
const cB = E.fullReading({ calendar: '양력', year: 1993, month: 7, day: 22, hour: 5, minute: 40, gender: '여', surname: '이', given: '서연' });
const cc = E.compatibility(cA, cB);
ok('총점 0~100', cc.total >= 0 && cc.total <= 100, true);
ok('네 축 모두 0~100', E.COMPAT_AXES.every((k) => cc.axes[k].score >= 0 && cc.axes[k].score <= 100), true);
ok('축마다 근거 항목이 있음', E.COMPAT_AXES.every((k) => Array.isArray(cc.axes[k].items)), true);
ok('강점은 전부 +', cc.strengths.every((s) => s.delta > 0), true);
ok('마찰은 전부 -', cc.frictions.every((s) => s.delta < 0), true);

// 환산 점수는 원점수에 대해 단조 증가해야 한다 — 아니면 순위가 뒤집힌다
section('궁합 — 환산 점수 단조성');
let mono = true, prev = -1;
const pool = [];
for (let y = 1970; y < 2000; y += 3) {
  pool.push(E.fullReading({ calendar: '양력', year: y, month: 6, day: 10, hour: 10, minute: 0,
                            gender: '남', skipLunar: true, skipFortune: true }));
}
const pairs = [];
pool.forEach((a) => pool.forEach((b) => { if (a !== b) { const c = E.compatibility(a, b); pairs.push([c.raw, c.total]); } }));
pairs.sort((x, y) => x[0] - y[0]).forEach((p) => { if (p[1] < prev) mono = false; prev = p[1]; });
ok('원점수가 오르면 환산 점수도 오름', mono, true);

section('궁합 — 알려진 관계가 반영되는가');
// 일간이 천간합(갑·기 등)인 짝을 실제 날짜에서 찾아 확인한다
function chartWithDayStem(stemIdx) {
  for (let d = 0; d < 60; d++) {
    const r = E.fullReading({ calendar: '양력', year: 1990, month: 1, day: 1 + d, hour: 12, minute: 0,
                              gender: '남', skipLunar: true, skipFortune: true });
    if (r.chart.pillars.day.stem === stemIdx) return r;
  }
  return null;
}
const gap = chartWithDayStem(0), gi = chartWithDayStem(5);   // 갑 · 기
ok('갑·기 일간 짝을 찾음', !!(gap && gi), true);
if (gap && gi) {
  const c2 = E.compatibility(gap, gi);
  ok('일간 천간합으로 판정', c2.detail.dayStemRelation, '천간합');
  ok('끌림에 천간합이 잡힘', c2.axes.attraction.items.some((i) => /천간합/.test(i.label)), true);
}

section('연락처 읽기');
const vcf = ['BEGIN:VCARD', 'FN:홍길동', 'BDAY:19900515', 'END:VCARD',
             'BEGIN:VCARD', 'N:김;서연;;;', 'BDAY;VALUE=DATE:1993-07-22', 'END:VCARD',
             'BEGIN:VCARD', 'FN:연도없음', 'BDAY:--0503', 'END:VCARD'].join('\n');
const pv = E.parseContacts(vcf);
ok('vCard 2명', pv.people.length, 2);
ok('vCard 한글 이름 순서', pv.people[1].name, '김서연');
ok('연도 없는 생일은 건너뜀', pv.skipped.length, 1);

const csv = 'Name,Birthday\n이도현,1988/02/17\n최민준,20010309\n생일없음,';
const pc = E.parseContacts(csv);
ok('CSV 2명', pc.people.length, 2);
ok('CSV 생일 없음 1명 건너뜀', pc.skipped.length, 1);

const plain = '홍길동 1990-05-15\n김서연,930722\n박지우\t1986.11.03\n날짜없는줄';
const pp = E.parseContacts(plain);
ok('붙여넣기 3명', pp.people.length, 3);
ok('두 자리 연도 추정', pp.people[1].year, 1993);
ok('날짜 없는 줄도 건너뜀에 남음', pp.skipped.length, 1);

section('생일 형식');
[['19900515', 1990], ['1990-05-15', 1990], ['1990.5.15', 1990], ['1990/05/15', 1990],
 ['1990. 5. 15.', 1990], ['930722', 1993], ['000101', 2000]].forEach(([raw, year]) => {
  const d = E.parseBirthday(raw);
  ok(raw, d && d.year, year);
});
ok('--0503 은 연도 없음', E.parseBirthday('--0503').noYear, true);
ok('읽을 수 없는 값', E.parseBirthday('abc'), null);

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
