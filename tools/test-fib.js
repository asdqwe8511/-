#!/usr/bin/env node
// 피보나치 역산 엔진 점검. 네트워크 없이 합성 캔들로 돈다.
//   node tools/test-fib.js
const assert = require('assert');
const E = require('../fib-engine.js');

const MS = 900000, T0 = Date.UTC(2025, 0, 1);
let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } }

// 가격 경로(꼭짓점)를 직선으로 이어 캔들을 만든다. 꼭짓점 사이는 steps 봉.
function path(points, steps, wick) {
  const out = []; let prev = points[0];
  out.push({ t: T0, o: prev, h: prev + wick, l: prev - wick, c: prev, v: 1 });
  for (let p = 1; p < points.length; p++) {
    for (let k = 1; k <= steps; k++) {
      const c = points[p - 1] + (points[p] - points[p - 1]) * k / steps;
      out.push({ t: T0 + out.length * MS, o: prev, h: Math.max(prev, c) + wick, l: Math.min(prev, c) - wick, c, v: 1 });
      prev = c;
    }
  }
  return out;
}
function bar(c, o, cl, h, l) { c.push({ t: T0 + c.length * MS, o, h, l, c: cl, v: 1 }); }

// 결정적 난수
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(n, drift, seed) {
  const r = rng(seed); let p = 20000; const out = [];
  for (let i = 0; i < n; i++) {
    const o = p, c = p + drift + (r() - 0.5) * 60;
    out.push({ t: T0 + i * MS, o, h: Math.max(o, c) + r() * 20, l: Math.min(o, c) - r() * 20, c, v: 1 });
    p = c;
  }
  return out;
}

console.log('지표');
t('ATR: 일정한 범위면 그 범위', () => {
  const c = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 10, h: 12, l: 10, c: 10, v: 1 }));
  assert.ok(Math.abs(E.atr(c, 14)[39] - 2) < 1e-9);
  assert.strictEqual(E.atr(c, 14)[12], null);
});
t('EMA: 상수열은 상수', () => {
  const e = E.ema(new Array(300).fill(7), 200);
  assert.strictEqual(e[198], null); assert.ok(Math.abs(e[299] - 7) < 1e-9);
});

console.log('피벗 — 미래 봉 금지');
t('확정 봉(오른쪽 5봉)이 닫히기 전에는 피벗이 나오지 않는다', () => {
  const c = path([100, 110, 100], 10, 0.01); // 고점 index 10
  assert.ok(E.findPivots(c, { upTo: 14 }).every((p) => p.index !== 10), '14번 봉까진 미확정');
  const p = E.findPivots(c, { upTo: 15 }).find((x) => x.index === 10 && x.type === 'H');
  assert.ok(p); assert.strictEqual(p.confirmedIndex, 15);
  assert.strictEqual(p.confirmedAt, c[15].t + MS);
});
t('접두 불변: 뒤 봉을 잘라 계산해도 확정된 피벗은 전체 계산과 같다', () => {
  const c = walk(600, 0, 7);
  const full = E.findPivots(c);
  for (const k of [150, 301, 480]) {
    const part = E.findPivots(c.slice(0, k + 1));
    const ref = full.filter((p) => p.confirmedIndex <= k);
    assert.deepStrictEqual(part.map((p) => [p.index, p.type, p.price]), ref.map((p) => [p.index, p.type, p.price]));
  }
});

console.log('방향 판정');
t('하락 지속이면 short, 상승 지속이면 long, 접두 불변', () => {
  const dn = walk(3000, -8, 3), up = walk(3000, 8, 3);
  assert.strictEqual(E.biasAt(dn, 2999).dir, 'short');
  assert.strictEqual(E.biasAt(up, 2999).dir, 'long');
  const a = E.biasAt(dn, 2000), b = E.biasAt(dn.slice(0, 2001), 2000);
  assert.deepStrictEqual(a, b);
});
t('상위봉 묶음은 다 차지 않은 마지막 묶음을 버린다', () => {
  const c = walk(10, 0, 1); // 10봉 = 1시간 두 묶음 + 2봉
  assert.strictEqual(E.resample(c, 3600000).length, 2);
});

console.log('피보 역산');
// 하락 파동: 시작 100(고점) → 목표 60. 0.618 = 84.72, 0.382 = 75.28 에 걸린 반등 고점.
const wave = path([100, 80, 84.72, 70, 75.28, 66], 8, 0.01);
t('두 개 이상의 확정 피벗이 맞는 0 후보가 1순위', () => {
  const fits = E.fitCandidates(wave, { startIdx: 0, startKind: 'H' });
  assert.ok(fits.length > 0);
  assert.ok(Math.abs(fits[0].P0 - 60) < 0.6, '1순위 P0=' + fits[0].P0);
  assert.ok(fits[0].count >= 2);
});
t('이미 도달한 가격은 미래 목표 0 이 될 수 없다', () => {
  const fits = E.fitCandidates(wave, { startIdx: 0, startKind: 'H' });
  const low = Math.min(...wave.map((b) => b.l));
  assert.ok(fits.every((f) => f.P0 < low));
});
t('asOf 이후 피벗은 쓰지 않는다(그때까지 알 수 있던 정보만)', () => {
  const early = E.fitCandidates(wave, { startIdx: 0, startKind: 'H', asOfIdx: 17 });
  assert.ok(early.every((f) => f.matches.every((m) => m.pivot.confirmedIndex <= 17)));
});
t('스냅샷은 고정(freeze)되고 확정 시각을 담는다', () => {
  const fit = E.fitCandidates(wave, { startIdx: 0, startKind: 'H' })[0];
  const snap = E.buildSnapshot(wave, { startIdx: 0, startKind: 'H' }, fit);
  assert.ok(Object.isFrozen(snap));
  assert.ok(snap.pivots.length >= 2 && snap.pivots.every((p) => p.confirmedAt > p.time));
  assert.strictEqual(snap.direction, 'down');
  const snap2 = E.buildSnapshot(wave, { startIdx: 0, startKind: 'H' }, fit);
  assert.notStrictEqual(snap.id, snap2.id); // 같은 피팅도 새 저장은 새 버전
});

console.log('돌파·리테스트·진입');
// 시작 100, 목표 0=60 을 수동 고정. 0.5 레벨 = 80.
function setup(build) {
  // 워밍업: ATR 이 생기도록 높은 곳에서 한참 횡보 후 하락
  const base = [];
  for (let i = 0; i < 20; i++) bar(base, 100, 100, 100.5, 99.5);
  base[19] = { t: base[19].t, o: 100, h: 100.6, l: 99.5, c: 100, v: 1 }; // 시작 고점 = 100.6
  build(base);
  const fit = { P1: 100.6, P0: 60, manual: true, matches: [] };
  const snap = E.buildSnapshot(base, { startIdx: 19, startKind: 'H' }, fit);
  return { c: base, snap };
}
const down = (c, from, to, n) => { for (let k = 1; k <= n; k++) { const a = from + (to - from) * (k - 1) / n, b = from + (to - from) * k / n; bar(c, a, b, Math.max(a, b) + 0.1, Math.min(a, b) - 0.1); } };
const lvl50 = () => 60 + (100.6 - 60) * 0.5; // 80.3

t('강한 돌파 + 3봉 확정 + 리테스트 거절 → 진입 후보, SL=리테스트 고점+0.25ATR', () => {
  const { c, snap } = setup((c) => {
    down(c, 100, 84, 8); down(c, 84, 77, 3); down(c, 77, 74, 3);   // 80.3 돌파
    bar(c, 74, 76, 77, 73.9); bar(c, 76, 79.7, 80.4, 75.9);        // 되돌림, 레벨 터치
    bar(c, 79.7, 79.2, 80.5, 78.9);                                // 레벨 위 고점 80.5 찍고 아래 마감 → 리테스트
    bar(c, 79.2, 78, 79.3, 77.8);
  });
  const ev = E.evaluateSetup(c, snap);
  const r = ev.levels.find((x) => x.ratio === 0.5);
  assert.ok(r.breakout && r.breakout.confirmIndex, '돌파 확정');
  assert.ok(r.entry, '진입 존재: ' + r.label);
  assert.strictEqual(r.entry.side, 'short');
  const A = E.atr(c, 14)[r.entry.index];
  assert.ok(Math.abs(r.entry.sl - (r.retest.extreme + 0.25 * A)) < 1e-9);
  assert.strictEqual(r.entry.tp, 60);               // 0 은 스냅샷 값 그대로
  assert.ok(r.entry.rr.rrNet < r.entry.rr.rrGross); // 비용 반영
});
t('돌파봉 몸통이 약하면 돌파로 인정하지 않는다', () => {
  const { c, snap } = setup((c) => {
    down(c, 100, 83, 8);
    bar(c, 83, 79.6, 90, 79); // 긴 꼬리, 몸통 ≈ 0.31
    down(c, 79.6, 70, 6);
  });
  const r = E.evaluateSetup(c, snap).levels.find((x) => x.ratio === 0.5);
  assert.strictEqual(r.breakout, null);
  assert.ok(r.attempts.some((a) => /몸통/.test(a.why)), JSON.stringify(r.attempts));
});
t('돌파 거리가 0.35 ATR 미만이면 인정하지 않는다', () => {
  const { c, snap } = setup((c) => {
    down(c, 100, 80.6, 8);
    bar(c, 80.6, 80.25, 80.62, 80.24); // 레벨(80.3) 아래 0.05 마감, 몸통은 큼
    down(c, 80.25, 74, 4);
  });
  const r = E.evaluateSetup(c, snap).levels.find((x) => x.ratio === 0.5);
  assert.ok(r.attempts.some((a) => /거리/.test(a.why)), JSON.stringify(r.attempts));
});
t('3봉 연속 종가가 안 채워지면 확정하지 않는다', () => {
  const { c, snap } = setup((c) => {
    down(c, 100, 84, 8); down(c, 84, 77, 2);
    bar(c, 77, 81.5, 81.6, 76.9); // 두 번째 봉에서 레벨 위로 복귀
    down(c, 81.5, 90, 3);
  });
  const r = E.evaluateSetup(c, snap).levels.find((x) => x.ratio === 0.5);
  assert.strictEqual(r.breakout, null);
  assert.ok(r.attempts.some((a) => /연속 종가/.test(a.why)));
});
t('리테스트 없이 목표 0 에 먼저 닿으면 놓친 신호', () => {
  const { c, snap } = setup((c) => { down(c, 100, 84, 8); down(c, 84, 70, 6); down(c, 70, 59, 4); });
  const r = E.evaluateSetup(c, snap).levels.find((x) => x.ratio === 0.5);
  assert.strictEqual(r.status, 'missed');
});
t('손익비 1:3 미만은 후보에서 제외', () => {
  const { c, snap } = setup((c) => {
    down(c, 100, 84, 8); down(c, 84, 77, 3); down(c, 77, 74, 3);
    bar(c, 74, 76, 77, 73.9); bar(c, 76, 79.7, 80.4, 75.9);
    bar(c, 79.7, 79.2, 80.5, 78.9); bar(c, 79.2, 78, 79.3, 77.8);
  });
  const ev = E.evaluateSetup(c, snap, { minRR: 1000 });
  assert.strictEqual(ev.firstCandidate, null);
  assert.strictEqual(ev.levels.find((x) => x.ratio === 0.5).status, 'rr-fail');
});
t('evaluateSetup 은 asOf 이후 봉에 영향받지 않는다', () => {
  const { c, snap } = setup((c) => {
    down(c, 100, 84, 8); down(c, 84, 77, 3); down(c, 77, 74, 3);
    bar(c, 74, 76, 77, 73.9); bar(c, 76, 79.7, 80.4, 75.9); bar(c, 79.7, 79.2, 80.5, 78.9);
    down(c, 79.2, 40, 10);
  });
  const k = c.length - 11;
  const a = E.evaluateSetup(c, snap, { asOfIdx: k });
  const b = E.evaluateSetup(c.slice(0, k + 1), snap);
  assert.deepStrictEqual(a.levels.map((x) => [x.status, x.entry && x.entry.price]), b.levels.map((x) => [x.status, x.entry && x.entry.price]));
});

console.log('체결 판정·비용');
t('숏: TP 먼저 / SL 먼저', () => {
  const c = []; bar(c, 100, 100, 100.1, 99.9); bar(c, 100, 97, 100.5, 96.8); bar(c, 97, 90, 97.5, 89);
  const tr = { side: 'short', entry: 100, sl: 101, tp: 90 };
  assert.strictEqual(E.simulateTrade(c, 0, tr).outcome, 'tp');
  const c2 = []; bar(c2, 100, 100, 100.1, 99.9); bar(c2, 100, 101.5, 101.6, 99.5);
  assert.strictEqual(E.simulateTrade(c2, 0, tr).outcome, 'sl');
});
t('한 봉에 SL·TP 가 모두 닿으면 유리하게 해석하지 않고 ambiguous', () => {
  const c = []; bar(c, 100, 100, 100.1, 99.9); bar(c, 100, 95, 101.5, 89);
  const r = E.simulateTrade(c, 0, { side: 'short', entry: 100, sl: 101, tp: 90 });
  assert.strictEqual(r.outcome, 'ambiguous');
  assert.ok(r.rWorst < 0 && r.rBest > 0);
});
t('R 은 비용만큼 깎인다 (SL 은 -1R 보다 나쁘다)', () => {
  const r = E.computeR({ side: 'long', entry: 100, sl: 99, exit: 99 });
  assert.ok(r.gross === -1 && r.net < -1);
  const rr = E.calcRR('long', 100, 99, 103);
  assert.ok(rr.rrGross === 3 && rr.rrNet < 3);
  assert.strictEqual(E.calcRR('long', 100, 101, 103), null);
});

console.log('위험 관리·일지');
t('수량: 손절 시 비용 포함 정확히 riskPct 만 잃는다', () => {
  const p = { side: 'long', balance: 10000, riskPct: 1, entry: 60000, sl: 59400, leverage: 10 };
  const s = E.positionSize(p);
  const loss = s.qty * (60000 - 59400 + E.costPrice(60000));
  assert.ok(Math.abs(loss - 100) < 1e-6);
  assert.ok(s.liq < 60000 && s.liqBeforeSL === false);
  assert.strictEqual(E.positionSize(Object.assign({}, p, { leverage: 100 })).liqBeforeSL, true);
});
t('일지 통계: 규칙 준수별 평균 R', () => {
  const s = E.journalStats([
    { date: '2025-01-01', r: 3, followed: true, emotions: [] },
    { date: '2025-01-02', r: -1, followed: true, emotions: ['손절 수용'] },
    { date: '2025-01-03', r: -2, followed: false, emotions: ['FOMO'] },
    { date: '2025-01-04', r: -1, followed: false, emotions: ['FOMO'] },
    { date: '2025-01-05', followed: true, emotions: [] } // 미청산
  ]);
  assert.strictEqual(s.closed, 4); assert.strictEqual(s.total, 5);
  assert.strictEqual(s.avgRFollowed, 1); assert.strictEqual(s.avgRBroke, -1.5);
  assert.strictEqual(s.maxLossStreak, 3); assert.strictEqual(s.tags.FOMO, 2);
});
t('수동 목표와 자동 목표의 차이', () => {
  const d = E.compareManual(60000, 60600, 300);
  assert.strictEqual(d.diff, 600); assert.strictEqual(d.pct, 1); assert.strictEqual(d.atr, 2);
});


console.log('청산 전략 (보호 SL·후행 SL)');
const mk = (rows) => rows.map((r, i) => ({ t: T0 + i * MS, o: r[0], h: r[1], l: r[2], c: r[3], v: 1 }));
// 숏: 진입 100, SL 101, TP 90. 0 번째 봉이 진입 봉.
const tr0 = { side: 'short', entry: 100, sl: 101, tp: 90 };
t('exit: 목표에서 전량 청산', () => {
  const c = mk([[100, 100.2, 99.8, 100], [100, 100.1, 95, 96], [96, 96.1, 89, 90]]);
  const r = E.simulateManaged(c, 0, tr0, {}, { afterTarget: 'exit' });
  assert.strictEqual(r.outcome, 'tp'); assert.ok(r.r > 9 && r.r < 10);
});
t('protect: 0 도달 후 SL 이 진입→목표 절반(95)으로 올라가고 거기서 청산', () => {
  const c = mk([[100, 100.2, 99.8, 100], [100, 100.1, 89.5, 90], [90, 96, 89.8, 95.5], [95.5, 95.6, 94, 94.5]]);
  const r = E.simulateManaged(c, 0, tr0, {}, { afterTarget: 'protect', protectFrac: 0.5 });
  assert.strictEqual(r.outcome, 'protect-stop'); assert.strictEqual(r.exitPrice, 95); assert.strictEqual(r.targetHit, true);
  assert.ok(r.r > 4.5 && r.r < 5); // (100-95)/1 = 5R 에서 비용만큼 덜
});
t('protect: 0 에 닿은 같은 봉에서는 새 SL 을 적용하지 않는다', () => {
  const c = mk([[100, 100.2, 99.8, 100], [100, 96, 89.5, 89.8], [89.8, 90, 80, 81]]);
  const r = E.simulateManaged(c, 0, tr0, {}, { afterTarget: 'protect', protectFrac: 0.5 });
  assert.strictEqual(r.outcome, 'open'); assert.ok(r.r > 0 && r.targetHit); // 96 > 95 이지만 같은 봉이라 청산 안 됨, 이후 계속 하락
});
t('SL·TP 같은 봉이면 ambiguous (전략 불문)', () => {
  const c = mk([[100, 100.2, 99.8, 100], [100, 101.5, 89, 95]]);
  ['exit', 'protect', 'trail'].forEach((m) => {
    const r = E.simulateManaged(c, 0, tr0, {}, { afterTarget: m });
    assert.strictEqual(r.outcome, 'ambiguous'); assert.ok(r.rWorst < 0 && r.rBest > 0);
  });
});
t('trail: 확정 스윙 고점으로만 유리하게 이동, 불리하게는 안 움직임', () => {
  // 목표 도달 후 하락하다 반등 고점(스윙 고점)을 만들고 그 위로 올라가 청산되는 경로
  const rows = [[100, 100.2, 99.8, 100], [100, 100.1, 89.5, 90]];
  let p = 90; for (let i = 0; i < 8; i++) { rows.push([p, p + 0.2, p - 1.2, p - 1]); p -= 1; }   // 82 까지 하락
  for (let i = 0; i < 6; i++) { rows.push([p, p + 1.2, p - 0.2, p + 1]); p += 1; }                // 반등: 고점 ~88.2
  for (let i = 0; i < 6; i++) { rows.push([p, p + 0.2, p - 1.2, p - 1]); p -= 1; }                // 다시 하락(스윙 고점 확정)
  rows.push([p, 95, p - 0.5, 94]);                                                                // 반등 급등
  const c = mk(rows);
  const rp = E.simulateManaged(c, 0, tr0, {}, { afterTarget: 'protect', protectFrac: 0.5 });
  const rt = E.simulateManaged(c, 0, tr0, {}, { afterTarget: 'trail', protectFrac: 0.5, pivotLeft: 3, pivotRight: 3 });
  assert.ok(rt.exitPrice < rp.exitPrice, 'trail 이 더 낮은(유리한) SL 에서 청산: ' + rt.exitPrice + ' vs ' + rp.exitPrice);
  assert.ok(rt.r > rp.r);
});

console.log('백테스트');
const sw = (n, seed) => { const r = rng(seed); let p = 20000; const out = []; for (let i = 0; i < n; i++) { const o = p, cl = p + (r() - .5) * 90; out.push({ t: T0 + i * MS, o, h: Math.max(o, cl) + r() * 25, l: Math.min(o, cl) - r() * 25, c: cl, v: 1 }); p = cl; } return out; };
t('fitCandidates 에 미리 계산한 피벗을 넘겨도 결과가 같다', () => {
  const c = sw(1500, 5), pv = E.findPivots(c);
  const a = E.fitCandidates(c, { startIdx: 1000, startKind: 'H', asOfIdx: 1300 });
  const b = E.fitCandidates(c, { startIdx: 1000, startKind: 'H', asOfIdx: 1300 }, { pivots: pv });
  assert.deepStrictEqual(a.map((f) => [f.P0, f.count]), b.map((f) => [f.P0, f.count]));
});
t('스냅샷 생성 이전 봉의 돌파는 신호로 인정하지 않는다 / 겹치는 포지션 없음', () => {
  let total = 0;
  for (const seed of [11, 12, 13, 14]) {
    const c = sw(5000, seed), bt = E.runBacktest(c, {});
    for (const x of bt.candidates) { total++; assert.ok(x.e.index > x.rec.k, '진입은 스냅샷 생성 뒤'); assert.ok(x.breakout.index > x.rec.k, '돌파도 생성 뒤'); }
    const r = E.tradeAll(c, bt, {}, { afterTarget: 'exit' }, false);
    for (let i = 1; i < r.trades.length; i++) {
      const prev = r.trades[i - 1]; assert.ok(prev.sim.outcome !== 'open' && r.trades[i].entryIndex > prev.sim.exitIndex, '겹침 없음');
    }
  }
  assert.ok(total > 0, '검증할 후보가 하나도 없음');
});
t('뒤 봉을 잘라 돌려도 앞쪽 진입 후보는 그대로다 (미래 정보 없음)', () => {
  let checked = 0;
  for (const seed of [21, 22, 23]) {
    const c = sw(5000, seed), cut = 4000;
    const key = (x) => [x.e.index, x.e.side, x.e.price, x.e.sl, x.level].join('|');
    const full = new Set(E.runBacktest(c, {}).candidates.filter((x) => x.e.index < cut).map(key));
    const part = E.runBacktest(c.slice(0, cut), {}).candidates.map(key);
    part.forEach((k) => { checked++; assert.ok(full.has(k), '잘린 데이터에서만 나온 신호: ' + k); });
    full.forEach((k) => assert.ok(part.includes(k), '전체에서만 나온 신호: ' + k));
  }
  assert.ok(checked > 0);
});
t('무작위 가격에서 비용 반영 평균 R 이 양수가 아니다 (낙관 편향 점검)', () => {
  let n = 0, sum = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const c = sw(5000, seed * 7 + 1), bt = E.runBacktest(c, {});
    E.tradeAll(c, bt, {}, { afterTarget: 'exit' }, false).trades.forEach((x) => { if (x.sim.outcome === 'tp' || x.sim.outcome === 'sl') { n++; sum += x.sim.r; } });
  }
  assert.ok(n > 100 && sum / n < 0, 'n=' + n + ' avgR=' + (sum / n));
});
t('통계: 모호한 거래는 최악/최선 두 값을 따로 합산', () => {
  const tr = [{ sim: { outcome: 'tp', r: 3, targetHit: true } }, { sim: { outcome: 'sl', r: -1.1, targetHit: false } }, { sim: { outcome: 'ambiguous', rWorst: -1.1, rBest: 3 } }, { sim: { outcome: 'open', r: 0.5 } }];
  const s = E.summarize(tr, null);
  assert.strictEqual(s.n, 4); assert.strictEqual(s.open, 1); assert.strictEqual(s.ambiguous, 1);
  assert.ok(Math.abs(s.totalRWorst - 1.3) < 1e-9 && Math.abs(s.totalRBest - 5.4) < 1e-9); // 진행 중은 종가 평가로 포함
  assert.ok(Math.abs(s.tradeTargetRate - 1 / 3) < 1e-9); // 순서 불명 제외 3건 중 1건이 0 도달(진행 중은 targetHit 미정=거짓)
});

console.log('워크포워드');
const WFC = { trainBars: 3000, testBars: 1500, warmBars: 1000, grid: { bodyRatio: [0.6, 0.8], minRR: [2, 3] }, minTrades: 3, useBias: false };
t('구간: 학습 바로 뒤가 검증, 검증끼리 이어지고 겹치지 않는다', () => {
  const r = E.walkForward(sw(9000, 31), {}, WFC);
  assert.strictEqual(r.folds.length, 3);
  r.folds.forEach((f, i) => { if (i) assert.strictEqual(f.test[0], r.folds[i - 1].test[1]); assert.strictEqual(f.train[1], f.test[0]); });
  assert.strictEqual(r.combos, 4);
});
t('검증 거래는 모두 검증 구간 안에서 진입한다', () => {
  const c = sw(9000, 32), r = E.walkForward(c, {}, WFC);
  const rngs = r.folds.map((f) => [f.test[0], f.test[1]]);
  r.oosTrades.forEach((tr) => assert.ok(rngs.some(([a, b]) => tr.entryTime >= a && tr.entryTime <= b), 'OOS 밖 진입'));
});
t('검증 구간 데이터를 바꿔도 첫 구간의 파라미터 선택·학습 성적은 그대로다 (누수 없음)', () => {
  const a = sw(9000, 33), b = a.map((x) => Object.assign({}, x));
  const cut = 1000 + 3000; // 첫 학습 끝 다음 봉부터 다른 가격
  const r2 = rng(999); let p = b[cut - 1].c;
  for (let i = cut; i < b.length; i++) { const o = p, cl = p + (r2() - .5) * 400; b[i] = { t: b[i].t, o, h: Math.max(o, cl) + 30, l: Math.min(o, cl) - 30, c: cl, v: 1 }; p = cl; }
  const x = E.walkForward(a, {}, WFC).folds[0], y = E.walkForward(b, {}, WFC).folds[0];
  assert.deepStrictEqual(x.chosen, y.chosen);
  assert.deepStrictEqual(x.isStats, y.isStats);
  assert.strictEqual(x.score, y.score);
});
t('학습 거래가 minTrades 에 못 미치면 그 구간은 거래하지 않는다', () => {
  const r = E.walkForward(sw(9000, 34), {}, Object.assign({}, WFC, { minTrades: 100000 }));
  assert.ok(r.folds.every((f) => f.chosen === null && /미만/.test(f.note)));
  assert.strictEqual(r.oos.n, 0);
});
t('t 값: 거래 수가 적으면 제외, 같은 평균이면 표본이 큰 쪽이 높다', () => {
  const mkT = (rs) => rs.map((r) => ({ sim: { outcome: 'tp', r } }));
  assert.strictEqual(E.tScore(mkT([1, 2]), 5), -Infinity);
  assert.ok(E.tScore(mkT([1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2]), 5) > E.tScore(mkT([1, 0, 2, 1, 0, 2]), 5));
});
t('봉이 모자라면 필요한 수를 알려 주며 실패한다', () => {
  assert.throws(() => E.walkForward(sw(3000, 35), {}, WFC), /최소 \d+봉 필요/);
});
t('무작위 가격에서 검증(OOS) 평균 R 이 양수가 아니다 (선택 편향이 새지 않았는지)', () => {
  let n = 0, sum = 0;
  for (let seed = 40; seed < 52; seed++) {
    const r = E.walkForward(sw(9000, seed), {}, WFC);
    r.oosTrades.forEach((x) => { n++; sum += x.sim.outcome === 'ambiguous' ? x.sim.rWorst : x.sim.r; });
  }
  assert.ok(n > 30 && sum / n < 0, 'n=' + n + ' avgR=' + (sum / n));
});

console.log('펀딩비');
const H8 = 8 * 3600000;
const fnd = (times, rate, mark) => times.map((x) => ({ t: x, rate, mark }));
t('롱은 양(+) 펀딩을 내고 숏은 받는다 (정산 횟수 × 률 × 마크가 ÷ 위험)', () => {
  const T = Date.UTC(2025, 0, 1, 1, 0), f = fnd([Date.UTC(2025, 0, 1, 8), Date.UTC(2025, 0, 1, 16), Date.UTC(2025, 0, 2, 0)], 0.0001, 50000);
  const base = { entry: 50000, sl: 49900, exit: 50000, entryT: T, exitT: Date.UTC(2025, 0, 2, 12), barMs: MS };
  const L = E.computeR(Object.assign({ side: 'long' }, base), { funding: f });
  assert.ok(Math.abs(L.fundingR - 3 * 5 / 100) < 1e-12, 'long fundingR=' + L.fundingR);
  assert.ok(Math.abs(L.net - (L.gross - L.costR - 0.15)) < 1e-12);
  const S = E.computeR({ side: 'short', entry: 50000, sl: 50100, exit: 50000, entryT: T, exitT: base.exitT, barMs: MS }, { funding: f });
  assert.ok(Math.abs(S.fundingR + 0.15) < 1e-12 && S.net > S.gross - S.costR); // 받으면 순손익이 늘어난다
  const neg = E.computeR(Object.assign({ side: 'long' }, base), { funding: fnd([Date.UTC(2025, 0, 1, 8)], -0.0002, 50000) });
  assert.ok(neg.fundingR < 0); // 음(−) 펀딩이면 롱이 받는다
});
t('정산 시각을 지나지 않는 거래는 펀딩이 0', () => {
  const T = Date.UTC(2025, 0, 1, 1, 0);
  const r = E.computeR({ side: 'long', entry: 100, sl: 99, exit: 101, entryT: T, exitT: T + 3 * 3600000, barMs: MS }, { funding: fnd([Date.UTC(2025, 0, 1, 8)], 0.01, 100) });
  assert.strictEqual(r.fundingR, 0);
});
t('청산 봉·진입 시각과 겹치는 정산은 내는 경우만 센다 (유리하게 해석 금지)', () => {
  const S0 = Date.UTC(2025, 0, 1, 8), entryT = S0 - 3600000;
  const mk = (side, rate, exitBarT) => E.fundingCostPrice({ side, entry: 100, entryT, exitBarT, barMs: MS }, { funding: fnd([S0], rate, 100) });
  assert.strictEqual(mk('long', 0.001, S0), 0.1); // 청산 봉 = [S0, S0+15m) 안에 정산이 있고 내는 쪽 → 센다
  assert.strictEqual(mk('short', 0.001, S0), 0);  // 받는 쪽 → 세지 않는다
  assert.strictEqual(mk('long', 0.001, S0 - MS), 0); // 정산이 청산 봉 다음 → 아직 안 지남
  assert.strictEqual(mk('short', 0.001, S0 + MS), -0.1); // 청산 봉 이전에 지나갔으면 확정적으로 받음
  const atEntry = (side) => E.fundingCostPrice({ side, entry: 100, entryT: S0, exitT: S0 + H8, barMs: MS }, { funding: fnd([S0], 0.001, 100) });
  assert.strictEqual(atEntry('long'), 0.1); assert.strictEqual(atEntry('short'), 0);
});
t('simulateManaged: 정산을 지나 들고 있으면 R 이 정확히 fundingR 만큼 달라진다', () => {
  // 롱 진입 100 → 목표 110, 08:00 UTC 정산을 지난 뒤 목표 도달
  const start = Date.UTC(2025, 0, 1, 6, 0), c = [];
  for (let i = 0; i < 12; i++) { const p = 100 + (i >= 6 ? 1.2 * (i - 5) : 0); c.push({ t: start + i * MS, o: p, h: p + (i === 11 ? 12 : 0.1), l: p - 0.1, c: p, v: 1 }); }
  c.push({ t: start + 12 * MS, o: 107, h: 111, l: 106.9, c: 110, v: 1 });
  const tr = { side: 'long', entry: 100, sl: 99, tp: 110 };
  const f = fnd([Date.UTC(2025, 0, 1, 8)], 0.0005, 100);
  // 12봉 × 15분 = 3시간 → 06:00~09:00. 08:00 정산을 지난다.
  const a = E.simulateManaged(c, 0, tr, {}, { afterTarget: 'exit' }), b = E.simulateManaged(c, 0, tr, { funding: f }, { afterTarget: 'exit' });
  assert.strictEqual(a.outcome, b.outcome);
  assert.ok(Math.abs((a.r - b.r) - b.fundingR) < 1e-12 && b.fundingR > 0, 'Δ=' + (a.r - b.r) + ' f=' + b.fundingR);
  assert.strictEqual(a.fundingR, 0);
});
t('요약: 펀딩 R 평균이 나온다', () => {
  const s = E.summarize([{ sim: { outcome: 'tp', r: 3, fundingR: 0.1, targetHit: true } }, { sim: { outcome: 'sl', r: -1, fundingR: 0.3, targetHit: false } }], null);
  assert.ok(Math.abs(s.avgFundingR - 0.2) < 1e-12);
});
t('백테스트: 펀딩 데이터를 주면 같은 신호에서 R 만 달라지고 신호는 그대로다', () => {
  const c = sw(5000, 61), bt = E.runBacktest(c, {});
  const fs = []; for (let x = Math.ceil(c[0].t / H8) * H8; x < c[c.length - 1].t; x += H8) fs.push({ t: x, rate: 0.0003, mark: 20000 });
  const a = E.tradeAll(c, bt, {}, { afterTarget: 'exit' }, false), b = E.tradeAll(c, bt, { funding: fs }, { afterTarget: 'exit' }, false);
  assert.deepStrictEqual(a.trades.map((x) => x.entryIndex), b.trades.map((x) => x.entryIndex));
  assert.ok(a.trades.length > 0);
  const dir = (x) => (x.side === 'long' ? 1 : -1);
  b.trades.forEach((x, i) => { if (x.sim.fundingR != null && dir(x) === 1) assert.ok(x.sim.r <= a.trades[i].sim.r + 1e-12); }); // 양(+) 펀딩이면 롱은 항상 불리
});

console.log(pass + '개 통과' + (process.exitCode ? ', 실패 있음' : ''));
