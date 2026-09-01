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

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
