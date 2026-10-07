'use strict';
// 거래소 상태(포지션·대기 트리거)와 전략 상태를 맞추는 한 번의 순회(tick).
// 거래소가 진실이다: 트리거가 체결됐는지는 포지션 목록으로만 안다.
const fs = require('fs');
const { newState, step } = require('./strategy');
const { findLevels } = require('./levels');

const DAY = 86400e3;

class LiveRunner {
  constructor({ cfg, broker, api, file, now = Date.now, log = console.log, computeLevels }) {
    Object.assign(this, { cfg, broker, api, file, now, log, halted: false, skip: new Set() });
    this.computeLevels = computeLevels
      || (async (sym, price) => findLevels(await api.klines(sym, 'D', cfg.levels.lookback), price, cfg.levels));
    this.s = { st: {}, levels: {}, levelsDay: -1 };
    if (file && fs.existsSync(file)) this.s = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  save() { if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.s)); }
  st(sym) { return (this.s.st[sym] ||= newState()); }

  async refreshLevels(uni, prices, day) {
    for (const sym of uni) {
      if (this.st(sym).phase !== 'WATCH' || !prices[sym]) continue;
      try {
        const lv = await this.computeLevels(sym, prices[sym]);
        this.s.levels[sym] = { support: lv.support && { price: lv.support.price }, resistance: lv.resistance && { price: lv.resistance.price } };
      } catch (e) { this.log(`levels ${sym}: ${e.message}`); }
    }
    this.s.levelsDay = day;
  }

  // 코인당 롱(지지선) 1 + 숏(저항선) 1. 현재가가 이미 선을 지난 쪽은 걸지 않는다.
  wanted(sym, price, now, room) {
    const st = this.st(sym), lv = this.s.levels[sym];
    if (this.halted || room <= 0 || st.phase !== 'WATCH' || now < st.cooldownUntil || !lv) return [];
    const out = [];
    if (lv.support && price > lv.support.price) out.push({ side: 'long', price: lv.support.price });
    if (lv.resistance && price < lv.resistance.price) out.push({ side: 'short', price: lv.resistance.price });
    return out;
  }

  async guard(label, fn) {
    try { return await fn(); } catch (e) { this.log(`${label}: ${e.message}`); return undefined; }
  }

  async tick() {
    const { cfg, broker: b } = this;
    const now = this.now();
    const tk = await this.api.tickers();
    const pos = await b.positions();
    const trigs = await b.triggers();

    const prices = {}, uni = new Set();
    for (const t of tk) {
      prices[t.symbol] = t.price;
      if (b.tradable(t.symbol) && t.turnover >= cfg.minTurnover24h) uni.add(t.symbol);
    }
    for (const sym of pos.keys()) uni.add(sym);

    const day = Math.floor(now / DAY);
    if (this.s.levelsDay !== day) await this.refreshLevels(uni, prices, day);

    const bySym = new Map();
    for (const t of trigs) (bySym.get(t.symbol) || bySym.set(t.symbol, []).get(t.symbol)).push(t);

    // 1) 체결된 포지션 반영 + 관리
    for (const [sym, p] of pos) {
      const st = this.st(sym), price = prices[sym];
      if (st.phase === 'WATCH') {                      // 트리거 체결(또는 이미 있던 포지션) 인수
        Object.assign(st, { phase: 'OPEN', side: p.side, entry: p.avgPrice, peak: p.avgPrice, openedAt: now });
        if (p.stopLoss > 0) Object.assign(st, { phase: 'LOCKED', stop: p.stopLoss, stopSetAt: now, stopOnExchange: p.stopLoss });
        this.log(`${sym} ${p.side} 진입 확인 @${p.avgPrice} (${st.phase})`);
      }
      // 포지션이 생겼으니 그 코인의 반대/같은 방향 대기 트리거는 전부 취소 (원웨이라 반대 체결은 포지션을 줄인다)
      for (const t of bySym.get(sym) || []) await this.guard(`cancel ${sym}`, () => b.cancel(sym, t.id));
      bySym.delete(sym);
      if (!price) continue;

      let closed = false;
      for (const a of step(st, price, now, cfg, this.s.levels[sym])) {
        if (a.type === 'CLOSE') {                      // 스탑이 거래소에서 안 걸렸을 때의 보험
          await this.guard(`close ${sym}`, () => b.closeMarket(sym, p.side, p.size));
          this.log(`${sym} 스탑 이탈 → 시장가 청산 요청`);
          closed = true;
        }
      }
      if (!closed && st.phase === 'LOCKED' && st.stop !== st.stopOnExchange) {
        try { await b.setStop(sym, st.stop); st.stopOnExchange = st.stop; this.log(`${sym} 스탑 ${st.stop}`); }
        catch (e) {
          this.log(`stop ${sym}: ${e.message}`);
          if (p.side === 'long' ? price <= st.stop : price >= st.stop)   // 이미 스탑선을 지났으면 거래소가 거절하니 직접 청산
            await this.guard(`close ${sym}`, () => b.closeMarket(sym, p.side, p.size));
        }
      }
    }

    // 2) 포지션이 사라진 코인(스탑 체결/청산/수동 청산) → 쿨다운
    for (const [sym, st] of Object.entries(this.s.st)) {
      if (st.phase !== 'WATCH' && !pos.has(sym)) {
        this.log(`${sym} 포지션 종료 (${st.phase})`);
        this.s.st[sym] = { ...newState(), cooldownUntil: now + cfg.cooldownMs };
      }
    }

    // 3) 대기 트리거 맞추기. 동시 포지션이 상한이면 전부 철회.
    const room = cfg.maxOpen - pos.size;
    const margin = cfg.seed / cfg.entryDivisor;
    let placed = 0, cancelled = 0;
    for (const sym of new Set([...uni, ...bySym.keys()])) {
      const want = this.wanted(sym, prices[sym], now, room);
      const have = bySym.get(sym) || [];
      const kept = new Set();
      for (const t of have) {
        const w = want.find((x) => x.side === t.side && !kept.has(x.side) && b.roundPrice(sym, x.price) === t.price);
        if (w) kept.add(w.side);
        else { await this.guard(`cancel ${sym}`, () => b.cancel(sym, t.id)); cancelled++; }
      }
      for (const w of want) {
        if (kept.has(w.side)) continue;
        const key = `${sym}|${w.side}|${w.price}`;
        if (this.skip.has(key)) continue;
        const id = await this.guard(`trigger ${sym}`, () => b.placeTrigger(sym, w.side, w.price, margin));
        if (id) placed++; else this.skip.add(key);   // 실패/한도 미달은 같은 선으로 재시도하지 않는다
      }
    }
    this.save();
    this.log(`${new Date(now).toISOString()} 포지션 ${pos.size}/${cfg.maxOpen} 신규트리거 ${placed} 철회 ${cancelled}`);
    return { positions: pos.size, placed, cancelled };
  }

  // 종료/중단: 대기 트리거를 모두 거둔다. 이미 열린 포지션은 건드리지 않는다.
  async shutdown() {
    this.halted = true;
    for (const t of await this.broker.triggers()) await this.guard(`cancel ${t.symbol}`, () => this.broker.cancel(t.symbol, t.id));
    this.save();
  }
}

module.exports = { LiveRunner };
