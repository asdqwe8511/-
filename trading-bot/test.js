'use strict';
const assert = require('assert');
const cfg = { ...require('./config') };
const { findLevels } = require('./lib/levels');
const { Paper } = require('./lib/paper');
const { Engine } = require('./lib/engine');
const { run } = require('./backtest');

const DAY = 86400e3, H = 3600e3;
const mk = () => { const b = new Paper(cfg); return { b, e: new Engine(cfg, b) }; };
const LV = (s, r) => ({ support: s && { price: s }, resistance: r && { price: r } });

// 1) 여러 번 닿은 가격대가 가장 강한 지지/저항으로 뽑힌다
{
  const c = [];
  for (let i = 0; i < 120; i++) {
    const w = Math.sin(i / 3) * 10;           // 90~110 박스 왕복
    c.push({ t: i * DAY, o: 100 + w, h: 100 + w + 1, l: 100 + w - 1, c: 100 + w, v: 1 });
  }
  const lv = findLevels(c, 100, cfg.levels);
  assert(lv.support && lv.support.price < 95 && lv.support.price > 85, 'support');
  assert(lv.resistance && lv.resistance.price > 105 && lv.resistance.price < 115, 'resistance');
}

// 2) 롱: 지지선 터치 진입 → 스탑 없음 → +10%에 손절선만 이익 50% 지점에 설정(물량 유지) → 1일 1회 상향 → 체결
{
  const { b, e } = mk();
  e.setLevels('X', LV(100, 120));
  e.onPrice('X', 99, 0);
  const p = b.pos.X;
  assert(p && p.side === 'long' && Math.abs(p.margin - cfg.seed / cfg.entryDivisor) < 1e-9, 'entry 1/10 margin');
  assert.strictEqual(e.st.X.stop, undefined, 'no stop at first entry');
  e.onPrice('X', 95, H); assert(b.pos.X, 'still held below entry without stop');
  const entry = p.entry, q0 = p.qty;
  e.onPrice('X', entry * 1.10, 2 * H);
  assert.strictEqual(b.pos.X.qty, q0, 'no partial close');
  assert(Math.abs(e.st.X.stop - entry * 1.05) < 1e-9, 'stop at half of profit (+5%)');
  e.onPrice('X', entry * 1.30, 3 * H); assert(Math.abs(e.st.X.stop - entry * 1.05) < 1e-9, 'no update inside 24h');
  e.onPrice('X', entry * 1.30, 2 * H + DAY + 1); assert(Math.abs(e.st.X.stop - entry * 1.15) < 1e-9, 'daily update to +15%');
  e.onPrice('X', entry * 1.20, 2 * H + 2 * DAY); assert(Math.abs(e.st.X.stop - entry * 1.15) < 1e-9, 'never loosens');
  e.onPrice('X', entry * 1.14, 2 * H + 2 * DAY + 1); assert(!b.pos.X, 'stopped out');
  assert(b.trades.at(-1).pnl > 0, 'profit locked');
}

// 3) 숏 대칭, 4) 스탑 없는 첫 진입은 청산까지 감, 5) 동시 포지션 상한
{
  const { b, e } = mk();
  e.setLevels('S', LV(80, 100)); e.onPrice('S', 101, 0);
  assert.strictEqual(b.pos.S.side, 'short');
  e.onPrice('S', b.pos.S.liq + 1, H);
  assert(!b.pos.S && b.trades.some((t) => t.ev === 'liquidated'), 'liquidated');
  assert(b.cash > 0 && Math.abs(b.cash - (cfg.seed - cfg.seed / cfg.entryDivisor)) < 20, 'loss capped at margin');
}
{
  const { b, e } = mk();
  for (let i = 0; i < 15; i++) { e.setLevels('C' + i, LV(100, 120)); e.onPrice('C' + i, 99, 0); }
  assert(b.openCount() <= cfg.maxOpen && b.openCount() >= cfg.maxOpen - 1, 'cap (수수료 때문에 마지막 1칸은 증거금 부족할 수 있음)');
}

// 6) 백테스트 배선 (합성 데이터)
{
  const daily = [], hourly = [];
  for (let i = 0; i < 150; i++) { const w = Math.sin(i / 3) * 10; daily.push({ t: i * DAY, o: 100 + w, h: 101 + w, l: 99 + w, c: 100 + w, v: 1 }); }
  for (let i = 100 * 24; i < 150 * 24; i++) { const w = Math.sin(i / 72) * 10; hourly.push({ t: i * H, o: 100 + w, h: 101.5 + w, l: 98.5 + w, c: 100 + w, v: 1 }); }
  const r = run({ SYN: { daily, hourly } }, cfg);
  assert(r.broker.trades.some((t) => t.ev === 'open'), 'backtest opens');
  assert(Number.isFinite(r.equity));
}
console.log('trading-bot tests ok');
