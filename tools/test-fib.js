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

console.log(pass + '개 통과' + (process.exitCode ? ', 실패 있음' : ''));
