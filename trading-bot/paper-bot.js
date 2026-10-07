'use strict';
// 실시간 모의 매매 (주문 없음, 공개 시세만). 사용: node paper-bot.js [코인수=50]
const fs = require('fs');
const cfg = require('./config');
const { Paper } = require('./lib/paper');
const { Engine } = require('./lib/engine');
const { findLevels } = require('./lib/levels');
const api = require('./lib/bybit-public');

const STATE = process.env.STATE_FILE || './paper-state.json';
const N = +process.argv[2] || 50;
const broker = new Paper(cfg), eng = new Engine(cfg, broker);
if (fs.existsSync(STATE)) {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  Object.assign(broker, s.broker); eng.st = s.st;
}
const save = () => fs.writeFileSync(STATE, JSON.stringify({ broker: { cash: broker.cash, pos: broker.pos, trades: broker.trades }, st: eng.st }));
let lastLevelDay = -1, universe = [];

async function refreshLevels(prices) {
  universe = Object.keys(prices);
  for (const sym of universe) {
    eng.setLevels(sym, findLevels(await api.klines(sym, 'D', cfg.levels.lookback + 10), prices[sym], cfg.levels));
  }
}

async function tick() {
  const all = (await api.tickers()).sort((a, b) => b.turnover - a.turnover).slice(0, N);
  const prices = Object.fromEntries(all.map((x) => [x.symbol, x.price]));
  const now = Date.now(), day = Math.floor(now / 86400e3);
  if (day !== lastLevelDay) { await refreshLevels(prices); lastLevelDay = day; }
  const before = broker.trades.length;
  for (const [s, p] of Object.entries(prices)) eng.onPrice(s, p, now);
  for (const t of broker.trades.slice(before)) console.log(new Date(t.t).toISOString(), t.sym, t.ev, t.side, t.price.toFixed(4), t.pnl?.toFixed(2) ?? '');
  save();
  console.log(new Date(now).toISOString(), `자산 ${broker.equity(prices).toFixed(2)} 포지션 ${broker.openCount()}`);
}

(async () => { for (;;) { try { await tick(); } catch (e) { console.error(e.message); } await new Promise((r) => setTimeout(r, 15000)); } })();
