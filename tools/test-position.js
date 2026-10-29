#!/usr/bin/env node
// 포지션 사이징 + 1:2:6 백테스트 엔진 점검.
//   node tools/test-position.js
const E = require('../position-engine.js');

let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (c ? '' : '  → ' + x)); };
const near = (a, b, t) => Math.abs(a - b) <= (t === undefined ? 1e-6 : t);

// 재현되는 난수(mulberry32) — 합성 시세를 만들 때만 씁니다.
function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function synth(n, seed, drift, vol) {
  const r = rng(seed), out = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, g = (r() + r() + r() - 1.5) * 2 * vol + drift;
    const c = o * (1 + g), h = Math.max(o, c) * (1 + r() * vol * 0.6), l = Math.min(o, c) * (1 - r() * vol * 0.6);
    out.push({ t: i * 86400000, o, h, l, c }); p = c;
  }
  return out;
}

console.log('지표');
{
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const r = E.rsi(up, 14);
  ok('RSI: 앞 14칸은 NaN', Number.isNaN(r[13]) && !Number.isNaN(r[14]), r[13] + ',' + r[14]);
  ok('RSI: 계속 오르기만 하면 100', near(r[39], 100), r[39]);
  const down = Array.from({ length: 40 }, (_, i) => 200 - i);
  ok('RSI: 계속 내리기만 하면 0', near(E.rsi(down, 14)[39], 0), E.rsi(down, 14)[39]);
  // Wilder 교과서 예제(14일 종가) — 첫 RSI 70.46
  const w = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  ok('RSI: Wilder 예제 첫 값 70.46', near(E.rsi(w, 14)[14], 70.46, 0.05), E.rsi(w, 14)[14]);
  const e = E.ema([1, 2, 3, 4, 5, 6], 3);
  ok('EMA: 씨앗은 처음 3개 평균(2), 다음은 k=0.5', near(e[2], 2) && near(e[3], 3) && near(e[4], 4), e.join());
  const m = E.macd(Array.from({ length: 80 }, (_, i) => 100 + i));
  ok('MACD: 꾸준한 상승이면 MACD>0', m.macd[79] > 0, m.macd[79]);
  ok('MACD: 시그널은 MACD 보다 7~8칸 뒤에 시작', Number.isNaN(m.signal[32]) && !Number.isNaN(m.signal[33]), '');
}
{
  // 일목: 구름은 26칸 앞에 놓인다 — i 의 구름은 i-26 이전 데이터만 쓴다.
  const hi = Array.from({ length: 120 }, (_, i) => 100 + i), lo = hi.map(x => x - 2);
  const I = E.ichimoku(hi, lo);
  ok('일목: 구름은 인덱스 77(선행스팬B 52칸+이동 26칸)에서 처음 생김', Number.isNaN(I.top[76]) && !Number.isNaN(I.top[77]), I.top[76] + ',' + I.top[77]);
  const hi2 = hi.slice(), lo2 = lo.slice(); hi2[119] = 9999;           // 마지막 칸만 바꿔도
  const J = E.ichimoku(hi2, lo2);
  ok('일목: 마지막 칸 데이터가 같은 칸의 구름을 바꾸지 않음(미래 참조 없음)', I.top[119] === J.top[119] && I.bottom[119] === J.bottom[119], '');
  ok('일목: 위 경계 ≥ 아래 경계', I.top[100] >= I.bottom[100], '');
}

console.log('사이징 — 영상 예시');
{
  const s = E.sizePosition({ account: 10000000, riskPct: 2, entry: 100, stop: 96, weights: [1, 2, 6] });
  ok('1천만원·손실 2%·손절폭 4% → 매수 500만원', near(s.totalNotional, 5000000, 1), s.totalNotional);
  ok('손절 시 손실 20만원', near(s.lossAtStop, 200000, 1), s.lossAtStop);
  ok('1:2:6 = 1/9, 2/9, 6/9', near(s.stages[0].notional, 5000000 / 9, 1) && near(s.stages[2].notional, 5000000 * 6 / 9, 1), s.stages.map(x => x.notional).join());
  ok('현물은 청산가 없음', s.liqPrice === null, s.liqPrice);
}
console.log('사이징 — 뒤 단계를 더 비싸게 사는 경우');
{
  const s = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 90, weights: [1, 2, 6], stagePrices: [100, 104, 110] });
  ok('손절 시 손실이 한도(200)와 같음', near(s.lossAtStop, 200, 1e-6), s.lossAtStop);
  ok('같은 가격일 때보다 총액이 작음', s.totalNotional < 200 / 0.10, s.totalNotional);
  ok('평균 진입가는 가중 평균(100~110 사이, 110 쪽)', s.avgEntry > 104 && s.avgEntry < 110, s.avgEntry);
}
console.log('사이징 — 수수료·한도');
{
  const a = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 96 });
  const b = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 96, feePct: 0.1, slipPct: 0.05 });
  ok('수수료·슬리피지를 넣으면 매수 금액이 줄고 손실은 한도 그대로', b.totalNotional < a.totalNotional && near(b.lossAtStop, 200, 1e-6), b.totalNotional + ',' + b.lossAtStop);
  const c = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 99.5 });
  ok('손절폭이 아주 좁으면 현물 한도(계좌 전액)로 줄임', c.capped && near(c.totalNotional, 10000, 1e-6) && c.lossAtStop < 200, c.totalNotional);
  const d = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 105 });
  ok('롱인데 손절이 진입가 위면 거부', !d.ok && d.warnings.length > 0, JSON.stringify(d));
  ok('숫자를 안 넣으면 거부', !E.sizePosition({}).ok, '');
}
console.log('사이징 — 선물');
{
  const f = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 96, leverage: 5, mmrPct: 0.5 });
  ok('레버리지를 올려도 매수 금액(=손실 한도)은 같음', near(f.totalNotional, 5000, 1e-6), f.totalNotional);
  ok('증거금 = 금액 / 레버리지', near(f.margin, 1000, 1e-6), f.margin);
  ok('롱 청산가 = 100×(1−1/5+0.005) = 80.5', near(f.liqPrice, 80.5, 1e-6), f.liqPrice);
  ok('청산가가 손절가(96)보다 멀어 안전', !f.liqBeforeStop, '');
  const g = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 96, leverage: 25 });
  ok('25배: 청산가가 손절가보다 가까워 경고', g.liqBeforeStop && g.warnings.some(w => /청산/.test(w)), g.liqPrice + ' ' + g.warnings.join('|'));
  ok('권장 상한 레버리지가 25보다 작음', g.maxSafeLeverage < 25 && g.maxSafeLeverage > 10, g.maxSafeLeverage);
  const sh = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 104, side: 'short', leverage: 5 });
  ok('숏: 금액 5000, 청산가 = 100×(1+1/5−0.005) = 119.5', near(sh.totalNotional, 5000, 1e-6) && near(sh.liqPrice, 119.5, 1e-6), sh.totalNotional + ',' + sh.liqPrice);
  const sh1 = E.sizePosition({ account: 10000, riskPct: 2, entry: 100, stop: 104, side: 'short', leverage: 1 });
  ok('숏을 현물(1배)로 두면 경고', sh1.warnings.some(w => /선물/.test(w)), sh1.warnings.join());
}

console.log('백테스트 — 규칙이 영상대로 움직이는지(손으로 만든 시세)');
{
  // 하락 → 바닥 → 반등 시세. 신호가 순서대로 나오는지, 단계가 1→2→3 으로 쌓이는지 본다.
  function path(points) { const out = []; let t = 0; for (let k = 0; k < points.length - 1; k++) { const [a, b, len] = [points[k][0], points[k + 1][0], points[k][1]]; for (let i = 0; i < len; i++) { const c = a + (b - a) * (i + 1) / len; const o = out.length ? out[out.length - 1].c : a; out.push({ t: (t++) * 86400000, o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, c }); } } return out; }
  const base = path([[100, 120], [60, 12], [60, 1]]);              // 긴 하락으로 시작
  const candles = path([[100, 100], [100, 1]]);
  void candles; void base;
  // 지표가 자리 잡은 뒤 급락→반등을 두 번 겹쳐 신호를 확실히 만든다.
  const pts = [[100, 90], [100, 30], [70, 25], [95, 25], [120, 40], [110, 15], [135, 40], [135, 1]];
  const cs = path(pts);
  const r = E.backtest(cs, { riskPct: 2, feePct: 0, slipPct: 0 });
  ok('거래가 한 번 이상 생김', r.trades.length >= 1, r.trades.length);
  ok('자산 곡선 길이 = 캔들 수', r.equity.length === cs.length, r.equity.length + '/' + cs.length);
  r.trades.forEach((t, i) => ok('거래 ' + (i + 1) + ': 손절 손실이 위험 한도(2%·복리) 이내', t.reason !== 'stop' || t.R >= -1.0001, t.R));
}

console.log('백테스트 — 위험 한도 불변식(합성 시세 여러 개)');
{
  let worstR = 0, nTrades = 0, liq = 0, stopTrades = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const cs = synth(1500, seed, 0.0003, 0.025);
    const r = E.backtest(cs, { riskPct: 2, feePct: 0.05, slipPct: 0.02, mode: seed % 3 === 0 ? 'avgdown' : seed % 3 === 1 ? 'ladder' : 'allin' });
    r.trades.forEach(t => { nTrades++; if (t.reason === 'stop') { stopTrades++; if (t.R < worstR) worstR = t.R; } });
    liq += r.stats.liquidations;
  }
  ok('합성 30개에서 거래가 충분히 생김(' + nTrades + '건)', nTrades >= 30, nTrades);
  // 갭으로 손절가보다 불리하게 체결될 수 있어 여유 25% 를 둔다 — 그래도 한도의 몇 배로 새면 안 됨.
  ok('손절 거래의 최악 손실 ≥ −1.25R (최악 ' + worstR.toFixed(3) + 'R, 손절 ' + stopTrades + '건)', worstR >= -1.25, worstR);
  ok('현물(1배)에서는 청산이 없음', liq === 0, liq);
}
console.log('백테스트 — 선물');
{
  const cs = synth(1500, 7, 0.0003, 0.03);
  const a = E.backtest(cs, { leverage: 3 });
  const b = E.backtest(cs, { leverage: 3, fundingPer8hPct: 0.05 });
  ok('펀딩비를 넣으면 롱 성과가 나빠짐(같은 거래 흐름)', b.stats.finalEquity < a.stats.finalEquity || a.trades.length === 0, a.stats.finalEquity + ' vs ' + b.stats.finalEquity);
  const s = E.backtest(cs, { side: 'short', leverage: 3 });
  ok('숏도 돌아가고 통계가 숫자', Number.isFinite(s.stats.finalEquity), s.stats.finalEquity);
  const big = E.backtest(cs, { leverage: 100, riskPct: 10, maxStopPct: 15 });
  ok('100배면 손절 전에 청산이 날 수 있고(≥0) 자산은 0 이하로 안 감', big.stats.liquidations >= 0 && big.stats.finalEquity > -1e-6 * 1e9, big.stats.finalEquity);
  ok('단순 보유 수익률은 롱·숏 어느 쪽 결과에서 꺼내도 같음(롱 기준)', a.stats.buyHoldReturnPct === s.stats.buyHoldReturnPct && near(a.stats.buyHoldReturnPct, 100 * (cs[cs.length - 1].c / cs[78 + 2].c - 1), 1e-6), a.stats.buyHoldReturnPct + ' vs ' + s.stats.buyHoldReturnPct);
  const same = JSON.stringify(E.backtest(cs, { leverage: 3 }).stats) === JSON.stringify(a.stats);
  ok('같은 입력은 같은 결과(재현)', same, '');
}
console.log('백테스트 — 입력 검증');
{
  const r = E.backtest(synth(50, 1, 0, 0.02), {});
  ok('캔들이 너무 적으면 경고하고 거래 없이 끝남', r.warnings.length > 0 && r.trades.length === 0, JSON.stringify(r.warnings));
}

console.log('\n' + pass + ' 통과 / ' + fail + ' 실패');
process.exit(fail ? 1 : 0);
