'use strict';
// 사용: node backtest.js [코인수=30]   (Bybit 공개 시세가 열려 있는 네트워크에서 실행)
const cfg = require('./config');
const { Paper } = require('./lib/paper');
const { Engine } = require('./lib/engine');
const { findLevels } = require('./lib/levels');
const api = require('./lib/bybit-public');

const DAY = 86400e3;

// 1시간봉 하나를 시가→(저/고)→종가 순서의 가격 점들로 펼친다.
const path = (k) => (k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c]);

function run(series, cfg) {
  // series: { SYM: { daily:[...], hourly:[...] } }
  const broker = new Paper(cfg), eng = new Engine(cfg, broker);
  const events = [];
  for (const [sym, s] of Object.entries(series)) for (const k of s.hourly) events.push({ sym, k });
  events.sort((a, b) => a.k.t - b.k.t);
  const last = {}, curve = [];
  let day = -1;
  for (const { sym, k } of events) {
    const d = Math.floor(k.t / DAY);
    if (d !== day) {                       // 하루 시작: 전 코인 지지/저항 갱신
      day = d;
      for (const [s, ser] of Object.entries(series)) {
        const px = last[s] ?? ser.hourly[0].o;
        eng.setLevels(s, findLevels(ser.daily.filter((x) => x.t < d * DAY), px, cfg.levels));
      }
      curve.push({ t: d * DAY, equity: broker.equity(last) });
    }
    for (const px of path(k)) { last[sym] = px; eng.onPrice(sym, px, k.t + 3599e3); }
  }
  return { broker, equity: broker.equity(last), curve };
}

function report(r, cfg) {
  const t = r.broker.trades;
  const cnt = (ev) => t.filter((x) => x.ev === ev).length;
  let peak = cfg.seed, mdd = 0;
  for (const c of r.curve) { peak = Math.max(peak, c.equity); mdd = Math.max(mdd, 1 - c.equity / peak); }
  console.log(`시드 ${cfg.seed} → 종료 자산 ${r.equity.toFixed(2)} (${((r.equity / cfg.seed - 1) * 100).toFixed(1)}%)`);
  console.log(`진입 ${cnt('open')}  스탑 ${cnt('stop')}  청산 ${cnt('liquidated')}  최대낙폭 ${(mdd * 100).toFixed(1)}%`);
  console.log(`미청산 포지션 ${Object.keys(r.broker.pos).length}개 (평가손익 포함)`);
}

module.exports = { run, report };

if (require.main === module) (async () => {
  const n = +process.argv[2] || 30;
  const list = (await api.tickers()).sort((a, b) => b.turnover - a.turnover).slice(0, n);
  const series = {};
  for (const { symbol } of list) {
    series[symbol] = { daily: await api.klines(symbol, 'D', 1000), hourly: await api.klines(symbol, '60', 1000) };
    process.stdout.write('.');
  }
  console.log();
  report(run(series, cfg), cfg);
})().catch((e) => { console.error(e.message); process.exit(1); });
