#!/usr/bin/env node
// EMA200 리테스트 전략 엔진 점검. 가짜 캔들로 규칙 하나하나를 확인한다.
//   node tools/test-trade.js
const T = require('../trade-engine.js');
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (c ? '' : '  → ' + x)); };
const H = 4 * 3600000, D = 86400000, T0 = Date.UTC(2023, 0, 1);

// ema
const e = T.ema([1, 2, 3, 4, 5], 3);
ok('EMA 앞쪽은 null, 첫 값은 SMA', e[1] === null && e[2] === 2, JSON.stringify(e));
ok('EMA 다음 값 = c*k+prev*(1-k)', Math.abs(e[3] - 3) < 1e-9, e[3]);

// bodyBelow
ok('몸통이 전부 아래면 1', T.bodyBelow({ o: 90, c: 80, h: 91, l: 79 }, 100) === 1);
ok('몸통이 전부 위면 0', T.bodyBelow({ o: 110, c: 120, h: 121, l: 109 }, 100) === 0);
ok('몸통 절반 걸치면 0.5', T.bodyBelow({ o: 110, c: 90, h: 112, l: 88 }, 100) === 0.5);
ok('도지는 종가 쪽', T.bodyBelow({ o: 99, c: 99, h: 101, l: 97 }, 100) === 1);

// 합성 시나리오: 일봉/4시간봉을 같은 가격으로 길게 깔아 EMA200 이 평평하게 100 근처가 되게 한다.
const flat = (n, p) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, o: p, h: p + 0.1, l: p - 0.1, c: p }));
const mk = (o, c, h, l, i) => ({ t: T0 + i * H, o, c, h: h == null ? Math.max(o, c) : h, l: l == null ? Math.min(o, c) : l });
const dailyFrom = (h4, price) => { // 하루 종가를 price 로 고정한 일봉 (EMA 를 원하는 쪽에 두기 위해)
  const days = Math.ceil(h4.length / 6) + 300; // 4시간봉보다 앞서 200개 이상 확보
  // 앞쪽은 100 에 두고 뒤 30일만 price 로 바꿔, 종가가 EMA200 과 확실히 다른 쪽에 오게 한다.
  return Array.from({ length: days }, (_, i) => { const p = i < days - 30 - Math.ceil(h4.length / 6) ? 100 : price;
    return { t: T0 - 300 * D + i * D, o: p, h: p, l: p, c: p }; });
};
const base = 260;
const build = (tail) => { const a = flat(base, 100); tail.forEach((c, k) => { c.t = T0 + (base + k) * H; a.push(c); }); return a; };

// 숏 정상 시나리오: 이탈봉 → 위로 되돌림 꼬리 + 아래 마감(리테스트) → 계속 하락 → 반대편 몸통 절반 이상 마감으로 손절
{
  const h4 = build([
    mk(100, 95, 100.1, 94.9),       // 이탈봉: 몸통 전부 EMA(≈100) 아래
    mk(95, 94, 95.5, 93.5),         // 아래에서 진행(선에 안 닿음)
    mk(94, 97, 98, 93.9),        // 선 아래에서 머무름
    mk(99.5, 98, 101, 97.5),        // …선에 닿았다가 아래 마감 → 진입 98
    mk(98, 90, 98.2, 89.5),
    mk(90, 85, 90.5, 84),
    mk(96, 110, 110.5, 95.5),      // 몸통 절반 이상이 선 위에서 마감 → 손절 110
  ]);
  const daily = dailyFrom(h4, 80);   // 일봉은 EMA200 아래 → 하방
  const r = T.run(h4, daily);
  ok('숏 거래가 1건 나온다', r.trades.length === 1, JSON.stringify(r.trades));
  const t = r.trades[0] || {};
  ok('진입은 리테스트 봉의 종가', t.dir === 'short' && t.entry === 98, JSON.stringify(t));
  ok('청산은 반대편 몸통 마감 봉의 종가', t.exit === 110, t.exit);
  ok('손익은 수수료 포함 (98→110 숏 = 손실)', t.pnl < 0 && Math.abs(t.pnl - ((98 - 110) / 98 - 0.0008)) < 1e-9, t.pnl);
}

// 일봉이 상방이면 같은 모양이라도 숏 진입 안 함(관망)
{
  const h4 = build([mk(100, 95, 100.1, 94.9), mk(95, 94, 95.5, 93.5), mk(94, 97, 98, 93.9), mk(99.5, 98, 101, 97.5), mk(98, 90, 98.2, 89.5)]);
  const r = T.run(h4, dailyFrom(h4, 120));
  ok('일봉 상방이면 숏 진입 없음', r.trades.length === 0 && r.state.stage !== 'holding', r.state.stage);
  ok('진입 못 한 이유가 skip 이벤트로 남는다', r.events.some(x => x.type === 'skip'));
}

// 꼬리로 선을 찌르기만 하면 손절 아님
{
  const h4 = build([
    mk(100, 95, 100.1, 94.9), mk(95, 94, 95.5, 93.5), mk(94, 97, 98, 93.9), mk(99.5, 98, 101, 97.5),
    mk(98, 97, 105, 96.5),          // 꼬리만 선 위로 길게
    mk(97, 90, 97.5, 89.5)]);
  const r = T.run(h4, dailyFrom(h4, 80));
  ok('꼬리 터치는 손절하지 않는다', r.trades.length === 0 && r.state.stage === 'holding', r.state.stage + ' ' + r.trades.length);
  ok('보유 중 최대 역행(MAE)이 기록될 준비: 상태에 평가손익', r.state.pnl > 0, r.state.pnl);
}

// 한 구간에 한 번: 진입 뒤 다시 리테스트가 와도 두 번째 진입 없음
{
  const h4 = build([
    mk(100, 95, 100.1, 94.9), mk(95, 94, 95.5, 93.5), mk(94, 97, 98, 93.9), mk(99.5, 98, 101, 97.5),
    mk(98, 90, 98.2, 89.5), mk(90, 99, 101, 89.8), mk(99, 96, 101, 95.5)]);
  const r = T.run(h4, dailyFrom(h4, 80));
  ok('같은 구간에서 두 번 진입하지 않는다', r.events.filter(x => x.type === 'entry').length === 1);
}

// 이탈 직후 반대편 이탈봉이 나오면 대기 취소 후 반대 방향으로 새로 시작
{
  const h4 = build([mk(100, 95, 100.1, 94.9), mk(95, 106, 106.5, 94.8)]);
  const r = T.run(h4, dailyFrom(h4, 120));
  ok('반대편 이탈봉이 새 구간을 연다(롱 대기)', r.state.stage === 'waiting' && r.state.dir === 'long', JSON.stringify(r.state));
}

// 데이터 부족
ok('데이터가 부족하면 nodata', T.run(flat(50, 100), dailyFrom(flat(50, 100), 100)).state.stage === 'nodata');

// summarize
const s = T.summarize([{ pnl: 0.1, mae: 0.02, bars: 10 }, { pnl: -0.05, mae: 0.04, bars: 4 }]);
ok('요약: 승률 50%, 평균 2.5%', s.winRate === 0.5 && Math.abs(s.avg - 0.025) < 1e-12);
ok('요약: 손익비 2', Math.abs(s.profitFactor - 2) < 1e-12);

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
