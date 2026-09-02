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
// 궁합은 짝의 성질이지 묻는 사람의 성질이 아니다. 링크를 누가 열든 같은 점수여야 한다.
section('궁합 — 방향을 바꿔도 같은 점수인가');
const names = [['김', '민준'], ['이', '서연'], ['박', '지우'], ['최', '민준'], ['정', '하윤']];
let asym = 0, checked = 0;
for (let i = 0; i < 40; i++) {
  const mk = (k) => E.fullReading({
    calendar: '양력', year: 1960 + ((i * 7 + k * 13) % 45),
    month: 1 + ((i * 5 + k * 3) % 12), day: 1 + ((i * 11 + k * 17) % 28),
    hour: (i * 3 + k * 5) % 24, minute: 0, gender: k % 2 ? '여' : '남',
    surname: names[(i + k) % 5][0], given: names[(i + k) % 5][1],
    skipLunar: true, skipFortune: true
  });
  const a = mk(0), b = mk(1);
  checked++;
  if (E.compatibility(a, b).total !== E.compatibility(b, a).total) asym++;
}
ok(`${checked}쌍 전부 방향 무관`, asym, 0);

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

section('별자리 (황경 기준이라 해마다 경계가 달라진다)');
const zod = (y, m, d) => E.fullReading(
  { year: y, month: m, day: d, hour: 12, minute: 0, gender: '남', skipLunar: true, skipFortune: true }
).zodiac.name;
ok('2000-03-20 (춘분 전)', zod(2000, 3, 20), '물고기자리');
ok('2000-03-21 (춘분 후)', zod(2000, 3, 21), '양자리');
ok('1985-12-21', zod(1985, 12, 21), '궁수자리');
ok('1985-12-22 (동지)', zod(1985, 12, 22), '염소자리');
ok('1993-07-22', zod(1993, 7, 22), '게자리');
ok('1993-07-23', zod(1993, 7, 23), '사자자리');
ok('띠', E.fullReading({ year: 1990, month: 5, day: 15, hour: 12, minute: 0, gender: '남',
  skipLunar: true, skipFortune: true }).animal, '말');

section('날짜 → 사주');
const pod = (y, m, d) => {
  const P = E.pillarsOfDate(y, m, d);
  return E.ganjiText(P.day).kor + '/' + E.ganjiText(P.month).kor + '/' + E.ganjiText(P.year).kor;
};
// 일주는 buildChart 와 같은 값이 나와야 한다(60갑자 기준점이 하나뿐이므로).
ok('1949-10-01 일진', E.ganjiText(E.pillarsOfDate(1949, 10, 1).day).kor, '갑자');
ok('2000-01-01 일진', E.ganjiText(E.pillarsOfDate(2000, 1, 1).day).kor, '무오');
// 입춘 전은 전년도 간지로 잡힌다.
ok('2024-02-03 연주 (입춘 전)', E.ganjiText(E.pillarsOfDate(2024, 2, 3).year).kor, '계묘');
ok('2024-02-05 연주 (입춘 후)', E.ganjiText(E.pillarsOfDate(2024, 2, 5).year).kor, '갑진');
ok('2024-02-03 월주 (축월)', E.ganjiText(E.pillarsOfDate(2024, 2, 3).month).kor.charAt(1), '축');
ok('2024-02-05 월주 (인월)', E.ganjiText(E.pillarsOfDate(2024, 2, 5).month).kor.charAt(1), '인');

section('오늘의 운세 · 달별 운세');
const rr = E.fullReading({ year: 1990, month: 5, day: 15, hour: 14, minute: 30, gender: '남' });
const day = E.dailyFortune(rr, { year: 2026, month: 9, day: 2 });
ok('일진', day.ganji.hanja, '己卯');
ok('아홉 영역', day.domains.length, 9);
ok('등급이 말', typeof day.grade.word, 'string');
ok('좋은 쪽 3개', day.best.length, 3);
ok('조언 있음', !!(day.advice && day.advice.good && day.advice.bad), true);
// 등급은 그 해 365일 안에서의 순위다 — 온 해가 같은 등급이면 잣대가 없는 것이다.
const yd = E.yearDays(rr, 2026);
ok('365일 채점', yd.length, 365);
const grades = {};
yd.forEach((x) => { grades[E.gradeOf(x.overall).word] = 1; });
ok('등급이 다섯 단계 다 나온다', Object.keys(grades).length, 5);
// 같은 날을 두 번 물으면 같은 답이어야 한다(캐시가 결과를 바꾸면 안 된다).
ok('두 번 물어도 같은 답', E.dailyFortune(rr, { year: 2026, month: 9, day: 2 }).overall, day.overall);

const ym = E.yearMonths(rr, 2026);
ok('열두 달', ym.months.length, 12);
ok('절기 경계 — 첫 달은 입춘부터', ym.months[0].fromDate.m + '/' + ym.months[0].fromDate.d, '2/4');
ok('아홉 영역 최고·최저', Object.keys(ym.domains).length, 9);
// 아홉 영역이 전부 같은 달을 가리키면 아홉 가지를 물은 뜻이 없다.
const bestMonths = {};
E.DOMAIN9.forEach((k) => { bestMonths[ym.domains[k].best.index] = 1; });
ok('영역마다 다른 달을 가리킨다', Object.keys(bestMonths).length >= 2, true);
ok('한 달치 날짜', E.monthDays(rr, 2026, 3).length, 31);

section('한자 후보표');
const H = require('../hanja-data.js');
ok('金은 김으로도 읽는다', H.candidates('김').some((c) => c.ch === '金'), true);
ok('두음법칙 — 李가 이에 있다', H.candidates('이').some((c) => c.ch === '李'), true);
ok('두음법칙 — 柳가 유에 있다', H.candidates('유').some((c) => c.ch === '柳'), true);
ok('두음법칙 — 본음도 남는다', H.candidates('리').some((c) => c.ch === '李'), true);
ok('간체자는 없다', H.candidates('민').some((c) => c.ch === '悯'), false);
ok('획수가 붙는다', H.candidates('민').find((c) => c.ch === '民').strokes, 5);
ok('획수를 모르면 null', H.candidates('민').find((c) => c.ch === '旻').strokes, null);
ok('없는 음', H.candidates('뷁').length, 0);

section('12운성');
// 널리 알려진 장생·건록·제왕 자리로 표 자체를 확인한다.
[['갑', '해', '장생'], ['갑', '인', '건록'], ['갑', '묘', '제왕'], ['갑', '신', '절'],
 ['을', '오', '장생'], ['을', '묘', '건록'], ['을', '인', '제왕'],
 ['병', '인', '장생'], ['병', '사', '건록'], ['병', '오', '제왕'],
 ['정', '유', '장생'], ['정', '오', '건록'], ['정', '사', '제왕'],
 ['무', '인', '장생'], ['기', '유', '장생'],
 ['경', '사', '장생'], ['경', '신', '건록'], ['경', '유', '제왕'],
 ['신', '자', '장생'], ['신', '유', '건록'], ['신', '신', '제왕'],
 ['임', '신', '장생'], ['임', '해', '건록'], ['임', '자', '제왕'],
 ['계', '묘', '장생'], ['계', '자', '건록'], ['계', '해', '제왕']].forEach(([st, br, want]) => {
  ok(st + '일간 ' + br + '지', E.twelveStage(E.STEM.indexOf(st), E.BRANCH.indexOf(br)).stage, want);
});
const R1 = E.fullReading({ year: 1990, month: 5, day: 15, hour: 14, minute: 30, gender: '남' });
ok('네 기둥 모두 단계가 나온다',
   ['year', 'month', 'day', 'hour'].every((k) => R1.analysis.twelveStages[k].stage), true);
const LS = E.luckStages(R1);
ok('대운 10개', LS.list.length, 10);
ok('지금 자리가 하나', LS.list.filter((L) => L.current).length, 1);
ok('앞으로 20년 최고·최저가 다르다', LS.peak.order !== LS.trough.order, true);

section('용신·희신·기신·구신');
const AN = R1.analysis;
ok('다섯 자리가 서로 다른 오행', new Set(Object.values(AN.fiveRoles)).size, 5);
ok('희신은 용신을 생한다', E.generates(AN.husin, AN.yongsin[0]), true);
ok('기신은 용신을 극한다', E.controls(AN.gisin, AN.yongsin[0]), true);
ok('구신은 기신을 생한다', E.generates(AN.gusin, AN.gisin), true);
ok('용신 보유 판정이 있다', typeof AN.yongsinHave.present, 'boolean');
const YS = E.yongsinSupply(R1);
ok('대운마다 용신 채움 여부', YS.luck.length, 10);
ok('가장 잘 채워지는 대운', YS.bestLuck.fills >= YS.worstLuck.fills, true);

section('십신 분포');
const GC = AN.godCount;
ok('열 가지 십신', Object.keys(GC).length, 10);
// 천간 3개(일간 제외) + 지지 지장간 합 = 기둥 수만큼. 시주가 있으면 3+4=7.
const gsum = Object.keys(GC).reduce((a, k) => a + GC[k], 0);
ok('합이 기둥 수와 맞는다 (천간 3 + 지지 4)', Math.abs(gsum - 7) < 0.05, true);
ok('넘치는 십신 목록', Array.isArray(AN.godExcess), true);
ok('없는 십신 목록', Array.isArray(AN.godMissing), true);

section('원국 형충파해합 — 자리별');
const NR = AN.natalRelations;
ok('자리 짝으로 나온다', NR.branches.every((r) => /^[연월일시]-[연월일시]$/.test(r.pair)), true);
ok('영역 설명이 붙는다', NR.branches.every((r) => r.area.length > 0), true);
// 충이 있는 사주로 확인 — 자오충
const R2 = E.fullReading({ year: 1984, month: 6, day: 20, hour: 0, minute: 30, gender: '남' });
ok('관계 개수 집계', typeof R2.analysis.natalRelations.counts, 'object');
ok('네 자리의 뜻', Object.keys(NR.positions).length, 4);

section('격국과 드문 구조');
const PR = E.fullReading({ year: 1990, month: 5, day: 15, hour: 14, minute: 30, gender: '남' });
ok('격국 이름 — ' + PR.analysis.pattern.name, /격$/.test(PR.analysis.pattern.name), true);
ok('무엇으로 잡았는지 — ' + PR.analysis.pattern.via, ['투간', '정기'].indexOf(PR.analysis.pattern.via) >= 0, true);
// 격국은 월지에서 잡는다. 열 가지가 고루 나와야 한다 — 하나로 쏠리면 판정이 틀린 것이다.
const seenPatterns = {};
for (let i = 0; i < 300; i++) {
  const x = E.fullReading({ year: 1950 + (i % 60), month: 1 + (i % 12), day: 1 + (i % 28),
    hour: i % 24, minute: 0, gender: '남', skipLunar: true, skipFortune: true });
  if (!x.error) seenPatterns[x.analysis.pattern.name] = 1;
}
ok('열 가지 격국이 모두 나온다', Object.keys(seenPatterns).length, 10);

const shapes = E.findRareShapes(PR.chart, PR.analysis);
ok('드문 구조마다 백분율이 붙는다',
   shapes.every((x) => typeof x.rarityPercent === 'number'), true);
ok('백분율은 0~100', shapes.every((x) => x.rarityPercent >= 0 && x.rarityPercent <= 100), true);

section('다섯 갈래의 상태');
const GG = E.godGroupStatus(PR.chart, PR.analysis);
ok('다섯 갈래', Object.keys(GG).length, 5);
ok('비겁·식상·재성·관성·인성',
   JSON.stringify(Object.keys(GG)), JSON.stringify(['비겁', '식상', '재성', '관성', '인성']));
ok('상태가 말로 나온다', GG.재성.state.length > 0, true);
ok('쓸 수 있는지 판단이 붙는다', GG.재성.usable.length > 0, true);
// 다섯 갈래의 양을 합하면 십신 전체와 같아야 한다.
const ggSum = Object.keys(GG).reduce((a, k) => a + GG[k].amount, 0);
const gcSum = PR.analysis.godList.reduce((a, g) => a + PR.analysis.godCount[g], 0);
ok(`다섯 갈래 합 ${ggSum} = 십신 합 ${gcSum}`, Math.abs(ggSum - gcSum) < 0.05, true);

section('건강 — 오행과 몸');
const HP = E.healthProfile(PR);
ok('치우친 오행마다 장부가 붙는다', HP.risks.every((x) => x.organs.length > 0), true);
ok('넘침/모자람으로 가른다', HP.risks.every((x) => ['넘침', '모자람'].indexOf(x.side) >= 0), true);
ok('기신이 걸리는 곳', HP.gisinBody.organs.length > 0, true);
ok('용신에 맞는 음식·움직임', !!(HP.yongsinCare.food && HP.yongsinCare.move), true);
ok('다섯 오행 모두 몸 배속이 있다', Object.keys(E.ELEM_BODY).length, 5);

section('배우자 자리와 인연');
const SP = E.spouseProfile(PR);
ok('일지가 배우자 자리', SP.seat.branch, E.BRANCH[PR.chart.pillars.day.branch]);
ok('일지의 십신', SP.seat.god.length > 0, true);
ok('남자는 재성을 배우자로 본다', SP.mateGod, '정재');
const SPF = E.spouseProfile(E.fullReading({ year: 1993, month: 7, day: 22, hour: 5, minute: 40, gender: '여' }));
ok('여자는 관성을 배우자로 본다', SPF.mateGod, '정관');
ok('인연이 드는 해에 이유가 붙는다', SP.years.every((x) => x.why.length > 0), true);

section('택일 — 무슨 일에 어느 날');
ok('일곱 가지 일', Object.keys(E.ACTIVITIES).length, 7);
const PD = E.pickDays(PR, 2026, 10, '계약', 3, { fromToday: false });
ok('좋은 날 3개', PD.good.length, 3);
ok('피할 날 3개', PD.bad.length, 3);
// 같은 날이 좋은 날이자 피할 날이면 아무 말도 안 한 것이다.
const gdays = PD.good.map((x) => x.day), bdays = PD.bad.map((x) => x.day);
ok('좋은 날과 피할 날이 겹치지 않는다', gdays.every((d2) => bdays.indexOf(d2) < 0), true);
ok('좋은 날이 피할 날보다 점수가 높다', PD.good[0].score > PD.bad[0].score, true);
ok('시간대까지 나온다', PD.good[0].hours.length, 2);
ok('시간에 범위가 적힌다 — ' + PD.good[0].hours[0].label,
   /\d\d:\d\d~\d\d:\d\d/.test(PD.good[0].hours[0].label), true);
// 일지를 충하는 날은 무슨 일이든 피해야 한다.
const clashDay = PD.all.find((x) => x.warn.some((w) => /일지\(내 자리\)를 충/.test(w)));
if (clashDay) {
  ok('일지 충일은 아래쪽에 놓인다',
     PD.all.filter((x) => x.score > clashDay.score).length > PD.all.length / 2, true);
}
// 일마다 다른 날을 가리켜야 나눈 뜻이 있다.
let actDiffer = 0;
for (let i = 0; i < 30; i++) {
  const x = E.fullReading({ year: 1955 + i, month: 1 + (i % 12), day: 1 + ((i * 9) % 28),
    hour: (i * 7) % 24, minute: 0, gender: i % 2 ? '남' : '여', skipLunar: true });
  if (x.error) continue;
  const tops = {};
  Object.keys(E.ACTIVITIES).forEach((k) => {
    tops[E.pickDays(x, 2026, 10, k, 1, { fromToday: false }).good[0].day] = 1;
  });
  if (Object.keys(tops).length >= 3) actDiffer++;
}
ok('30명 중 ' + actDiffer + '명은 일마다 세 날 이상으로 갈린다', actDiffer >= 24, true);
// 지나간 날은 좋은 날로 내밀지 않는다.
const nowK = new Date(Date.now() + 9 * 3600 * 1000);
const thisY = nowK.getUTCFullYear(), thisM = nowK.getUTCMonth() + 1, thisD = nowK.getUTCDate();
const PDnow = E.pickDays(PR, thisY, thisM, '계약', 3);
ok('오늘 이후만 고른다', PDnow.good.every((x) => x.day >= thisD || x.month > thisM), true);

section('궁합 — 이름이 일지 관계를 덮지 않는가');
const mk = (y, m, d, h, g, sn, gn) => E.fullReading(
  { year: y, month: m, day: d, hour: h, minute: 0, gender: g, surname: sn, given: gn, skipFortune: true });

// var ba 가 일지 인덱스와 이름 오행에 두 번 쓰여, 이름을 넣으면 일지 관계가
// 통째로 사라지던 적이 있다. 이름 유무로 일지 판정이 달라지면 안 된다.
const N1 = mk(1990, 5, 15, 14, '남', '김', '민준');
const N2 = mk(1993, 7, 22, 5, '여', '이', '서연');
const M1 = mk(1990, 5, 15, 14, '남', '', '');
const M2 = mk(1993, 7, 22, 5, '여', '', '');
const cn = E.compatibility(N1, N2), cm = E.compatibility(M1, M2);
ok('이름이 있어도 일지 관계는 같다',
   JSON.stringify(cn.detail.dayBranchRelations), JSON.stringify(cm.detail.dayBranchRelations));
ok('일지가 지지 이름으로 나온다', cn.detail.inner.branches.every((b2) => E.BRANCH.indexOf(b2) >= 0), true);
ok('겉궁합은 띠', cn.detail.outer.basis, '연지(띠)');
ok('속궁합은 일지', cn.detail.inner.basis, '일지(배우자 자리)');
ok('용신 교차 양방향', typeof cn.detail.cross.bHasWhatANeeds === 'number' &&
   typeof cn.detail.cross.aHasWhatBNeeds === 'number', true);

section('관계별 궁합');
const PA = mk(1990, 5, 15, 14, '남', '김', '민준');
const PB = mk(1993, 7, 22, 5, '여', '이', '서연');
const relc = E.relationCompat(PA, PB);
ok('여섯 가지 관계 (애인·부부·직장·동업·친구·가족)', Object.keys(relc.types).length, 6);
ok('등급이 말', typeof relc.types.lover.grade === 'string' && !/\d/.test(relc.types.lover.grade), true);
ok('좋은 점 있음', relc.types.work.good.length >= 1, true);
ok('걸리는 점 있음', relc.types.work.bad.length >= 1, true);
ok('할 말이 있다', !!(relc.talk && relc.talk.good && relc.talk.bad), true);
ok('할 행동이 있다', !!(relc.act && relc.act.good && relc.act.bad), true);
// 관계마다 무게가 다르니 점수도 갈려야 한다. 여섯이 늘 같으면 나눈 뜻이 없다.
let differ = 0;
for (let i = 0; i < 60; i++) {
  const a = mk(1950 + i, 1 + (i % 12), 1 + (i % 28), i % 24, i % 2 ? '남' : '여', '', '');
  const b = mk(1980 + (i % 30), 1 + ((i * 7) % 12), 1 + ((i * 5) % 28), (i * 3) % 24, i % 2 ? '여' : '남', '', '');
  const r2 = E.relationCompat(a, b);
  const set = {};
  E.REL_TYPES.forEach((t) => { set[r2.types[t].score] = 1; });
  if (Object.keys(set).length >= 2) differ++;
}
ok('60쌍 중 ' + differ + '쌍에서 관계마다 점수가 갈린다', differ >= 55, true);
// 백분위라면 무작위 짝의 중앙값이 50 근처여야 한다. 아니면 기준표가 낡은 것이다.
const scores = {};
E.REL_TYPES.forEach((t) => { scores[t] = []; });
const relPool = [];
for (let i = 0; i < 26; i++) {
  const r3 = mk(1945 + i * 2, 1 + (i % 12), 1 + ((i * 11) % 28), (i * 5) % 24, i % 2 ? '남' : '여', '', '');
  if (!r3.error) relPool.push(r3);
}
for (let i = 0; i < relPool.length; i++) {
  for (let j = i + 1; j < relPool.length; j++) {
    const r4 = E.relationCompat(relPool[i], relPool[j]);
    E.REL_TYPES.forEach((t) => { scores[t].push(r4.types[t].score); });
  }
}
E.REL_TYPES.forEach((t) => {
  const v = scores[t].slice().sort((a, b) => a - b);
  const mid = v[Math.floor(v.length / 2)];
  ok(E.REL_TYPE_LABEL[t] + ' 중앙값 ' + mid + ' (40~60이어야 함)', mid >= 40 && mid <= 60, true);
});

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
