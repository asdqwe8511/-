#!/usr/bin/env node
// 무손절 농장 전략 돌려 보기.
//
//   node trading/backtest.js                        한 번 돌리고 성적표
//   node trading/backtest.js --runs 500             씨앗 500개로 분포 보기
//   node trading/backtest.js --compare --runs 300   무손절/손절/배율 비교표
//   node trading/backtest.js --csv ./data           진짜 데이터로 돌리기
//
// 옵션: --seed 1 --days 141 --leverage 3 --stop 0.2 --cap 0.25 --stress 0.7
//       --symbols 8 --seed-equity 5000 --no-funding --no-dca --rebound 0.35 --json
//
// --rebound 는 크게 빠진 뒤 며칠에 걸쳐 얼마나 되돌리는 시장인지다.
// 무손절은 되돌림을 먹고 사는 전략이라 이 값 하나에 결과가 크게 갈린다.

const { makeMarket, loadCsvMarket } = require('./market');
const { runBacktest, metrics, DEFAULTS } = require('./strategy');

// --- 인자 읽기 ---
function parseArgs(argv) {
  const a = { flags: {}, };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--')) continue;
    const key = s.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a.flags[key] = true;
    else { a.flags[key] = next; i++; }
  }
  return a.flags;
}
const num = (v, d) => (v === undefined ? d : Number(v));

// --- 보기 좋게 ---
const w = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
const pad = (s, n, right = false) => {
  const gap = Math.max(0, n - w(s));
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
};
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const money = (x) => '$' + Math.round(x).toLocaleString('en-US');
function table(head, rows) {
  const widths = head.map((h, i) => Math.max(w(h), ...rows.map((r) => w(r[i]))));
  const line = (cells, right) => cells.map((c, i) => pad(c, widths[i], right && i > 0)).join('  ');
  const out = [line(head, false), widths.map((n) => '-'.repeat(n)).join('  ')];
  for (const r of rows) out.push(line(r, true));
  return out.join('\n');
}
function sparkline(values, width = 60) {
  const chars = '▁▂▃▄▅▆▇█';
  const step = Math.max(1, Math.ceil(values.length / width));
  const pick = [];
  for (let i = 0; i < values.length; i += step) pick.push(values[i]);
  const lo = Math.min(...pick), hi = Math.max(...pick);
  if (hi <= lo) return chars[0].repeat(pick.length);
  return pick.map((v) => chars[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 8))]).join('');
}
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

// --- 설정 만들기 ---
function configFrom(f) {
  const cfg = {
    startEquity: num(f['seed-equity'], DEFAULTS.startEquity),
    leverage: num(f.leverage, DEFAULTS.leverage),
    symbolCapPct: num(f.cap, DEFAULTS.symbolCapPct),
    intradayStress: num(f.stress, DEFAULTS.intradayStress),
    stopLossPct: f.stop !== undefined ? Number(f.stop) : null,
    fundingOn: !f['no-funding'],
  };
  if (f['no-dca']) cfg.maxAdds = 0;
  return cfg;
}
function marketFrom(f, seed) {
  if (f.csv) return loadCsvMarket(String(f.csv));
  return makeMarket({
    seed,
    days: num(f.days, 141),
    symbolCount: num(f.symbols, 8),
    reboundStrength: num(f.rebound, undefined),
  });
}

// --- 한 번 돌리고 자세히 ---
function reportSingle(f) {
  const seed = num(f.seed, 1);
  const market = marketFrom(f, seed);
  const cfg = configFrom(f);
  const res = runBacktest(market, cfg);
  const m = metrics(res);

  if (f.json) { console.log(JSON.stringify({ metrics: m, equityCurve: res.equityCurve }, null, 2)); return; }

  const eq = res.equityCurve;
  console.log('무손절 농장 전략 — 한 번 돌린 결과');
  console.log(market.synthetic ? `가짜 시장 seed=${seed}, ${market.days}일, 종목 ${market.symbols.length}개`
                               : `진짜 데이터 ${f.csv}, ${market.days}일, 종목 ${market.symbols.length}개`);
  console.log(`배율 ${cfg.leverage}배, 종목당 한도 ${pct(cfg.symbolCapPct, 0)}, ` +
              `손절 ${cfg.stopLossPct === null ? '없음(무손절)' : pct(cfg.stopLossPct, 0)}, ` +
              `물타기 ${cfg.maxAdds === 0 ? '안 함' : '최대 ' + (cfg.maxAdds ?? DEFAULTS.maxAdds) + '회'}`);
  console.log('');
  console.log(sparkline(eq));
  console.log('');
  console.log(table(['항목', '값'], [
    ['시작', money(res.startEquity)],
    ['최고점', `${money(m.peakEquity)} (${m.peakMultiple.toFixed(2)}배)`],
    ['끝', `${money(res.finalEquity)} (${m.multiple.toFixed(2)}배)`],
    ['총수익률', pct(m.totalReturn)],
    ['최대낙폭(MDD)', `${pct(m.mdd)} — ${m.mddDay}일차`],
    ['최악의 하루', `${pct(m.worstDay)} — ${m.worstDayIdx}일차`],
    ['최고의 하루', pct(m.bestDay)],
    ['청산', m.ruined ? `당함 (${m.ruinDay}일차)` : '안 당함'],
    ['정리한 매매', `${m.trades}건, 이긴 비율 ${pct(m.winRate, 0)}`],
    ['안 판 자리의 평가손익', money(m.openPnl)],
    ['그중 물려 있는 자리', `${m.openLosers}개, ${money(m.openLoss)}`],
    ['평균 보유', `${m.avgHold.toFixed(1)}일 (최장 ${m.maxHold}일)`],
    ['펀딩비 누계', money(m.fundingPaid) + (m.fundingPaid > 0 ? ' 냄' : ' 받음')],
    ['수수료 누계', money(m.feesPaid)],
    ['안 판 자리', `${m.openAtEnd}개`],
  ]));
  if (cfg.stopLossPct === null && m.winRate > 0.9 && m.openLosers > 0) {
    console.log('\n이긴 비율이 이렇게 높은 건 실력이 아니라 무손절의 지문이다.');
    console.log(`진 자리는 안 팔았으니 매매 통계에 안 잡힌다. 손실은 '안 판 자리 ${m.openLosers}개' 안에 ${money(-m.openLoss)} 만큼 살아 있다.`);
  }

  // 글에 나온 "6일 만에 78%" 같은 구간을 찾아 준다
  const win = 6;
  let worstRun = 0, worstAt = 0;
  for (let i = win; i < eq.length; i++) {
    if (eq[i - win] <= 0) continue;
    const r = eq[i] / eq[i - win] - 1;
    if (r < worstRun) { worstRun = r; worstAt = i; }
  }
  console.log(`\n가장 험했던 ${win}일: ${worstAt - win}일차 → ${worstAt}일차, ${pct(worstRun)} ` +
              `(${money(eq[worstAt - win])} → ${money(eq[worstAt])})`);

  const byWhy = {};
  for (const t of res.trades) byWhy[t.why] = (byWhy[t.why] || 0) + 1;
  console.log('정리 사유: ' + Object.entries(byWhy).map(([k, v]) => `${{
    target: '목표가 도달', flip: '추세꺾여 익절', stop: '손절', liquidated: '청산',
  }[k] || k} ${v}건`).join(', '));
}

// --- 씨앗을 바꿔 가며 여러 번 ---
function runMany(f, override, runs) {
  const out = [];
  for (let s = 1; s <= runs; s++) {
    const market = marketFrom(f, s);
    out.push(metrics(runBacktest(market, { ...configFrom(f), ...override })));
  }
  return out;
}
function summarize(ms) {
  const mult = ms.map((m) => m.multiple).sort((a, b) => a - b);
  const mdd = ms.map((m) => m.mdd).sort((a, b) => a - b);
  const winners = ms.filter((m) => m.multiple >= 5).map((m) => m.mdd).sort((a, b) => a - b);
  return {
    runs: ms.length,
    ruinRate: ms.filter((m) => m.ruined).length / ms.length,
    lossRate: ms.filter((m) => m.multiple < 1).length / ms.length,
    p5: q(mult, 0.05), median: q(mult, 0.5), p95: q(mult, 0.95),
    mean: mult.reduce((a, b) => a + b, 0) / mult.length,
    fiveX: ms.filter((m) => m.multiple >= 5).length / ms.length,
    mddMedian: q(mdd, 0.5), mddWorst: mdd[0],
    winnerMddMedian: winners.length ? q(winners, 0.5) : null,
  };
}

function reportMonteCarlo(f) {
  const runs = num(f.runs, 500);
  const ms = runMany(f, {}, runs);
  const s = summarize(ms);
  if (f.json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`같은 규칙, 시장만 바꿔 가며 ${runs}번 (${num(f.days, 141)}일, 배율 ${num(f.leverage, DEFAULTS.leverage)}배)\n`);
  console.log(table(['항목', '값'], [
    ['청산당한 비율', pct(s.ruinRate, 0)],
    ['원금도 못 지킨 비율', pct(s.lossRate, 0)],
    ['5배 이상 간 비율', pct(s.fiveX, 0)],
    ['배수 하위5%', s.p5.toFixed(2) + '배'],
    ['배수 중앙값', s.median.toFixed(2) + '배'],
    ['배수 상위5%', s.p95.toFixed(2) + '배'],
    ['배수 평균', s.mean.toFixed(2) + '배'],
    ['MDD 중앙값', pct(s.mddMedian, 0)],
    ['5배 간 계좌들의 MDD 중앙값', s.winnerMddMedian === null ? '해당 없음' : pct(s.winnerMddMedian, 0)],
  ]));
  console.log('\n평균이 중앙값보다 훨씬 높으면, 소수의 대박이 평균을 끌어올린 것이다.');
  if (s.winnerMddMedian !== null) {
    console.log(`5배를 만든 계좌들도 중간에 ${pct(-s.winnerMddMedian, 0)} 는 빠졌다. 5배와 큰 낙폭은 같이 온다.`);
  }
}

// --- 규칙을 하나씩 바꿔 가며 비교 ---
const VARIANTS = [
  ['원본: 무손절 3배', {}],
  ['무손절 2배', { leverage: 2 }],
  ['무손절 1배', { leverage: 1 }],
  ['손절 -20%', { stopLossPct: 0.20 }],
  ['손절 -50%(한 번 물탄 뒤)', { stopLossPct: 0.50 }],
  ['물타기 없음(무손절)', { maxAdds: 0 }],
  ['종목당 한도 10%', { symbolCapPct: 0.10 }],
  ['추세확인 없이 진입', { confirmDays: 1, shortExtraConfirm: 0 }],
];
function reportCompare(f) {
  const runs = num(f.runs, 300);
  const rows = [];
  for (const [name, override] of VARIANTS) {
    const s = summarize(runMany(f, override, runs));
    rows.push([name, pct(s.ruinRate, 0), s.median.toFixed(2), s.p95.toFixed(2),
               pct(s.fiveX, 0), pct(s.mddMedian, 0)]);
  }
  console.log(`규칙을 하나씩 바꿔 가며 각 ${runs}번씩 (${num(f.days, 141)}일)\n`);
  console.log(table(['변형', '청산률', '중앙배수', '상위5%배수', '5배+', 'MDD중앙'], rows));
  console.log('\n같은 시장 씨앗을 모든 변형에 똑같이 먹였다. 차이는 규칙에서만 온다.');
}

function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  if (f.compare) return reportCompare(f);
  if (f.runs) return reportMonteCarlo(f);
  return reportSingle(f);
}
if (require.main === module) main();
module.exports = { runMany, summarize, VARIANTS };
