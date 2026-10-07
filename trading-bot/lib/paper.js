'use strict';
// 모의 브로커: 격리 마진, 청산, 수수료. 실주문 어댑터도 이 인터페이스(open/reduce/close)를 따르면 된다.
class Paper {
  constructor(cfg) {
    this.cfg = cfg;
    this.cash = cfg.seed;
    this.pos = {};
    this.trades = [];
  }
  liqPrice(side, entry) {
    const { leverage: L, mmr } = this.cfg;
    return side === 'long' ? entry * (1 - 1 / L + mmr) : entry * (1 + 1 / L - mmr);
  }
  openCount() { return Object.keys(this.pos).length; }
  open(sym, side, price, margin, now) {
    if (this.pos[sym] || margin > this.cash) return null;
    const slip = side === 'long' ? 1 + this.cfg.slippage : 1 - this.cfg.slippage;
    const entry = price * slip;
    const qty = (margin * this.cfg.leverage) / entry;
    const fee = qty * entry * this.cfg.fee;
    this.cash -= margin + fee;
    this.pos[sym] = { side, entry, qty, margin, liq: this.liqPrice(side, entry) };
    this.trades.push({ t: now, sym, ev: 'open', side, price: entry, fee });
    return this.pos[sym];
  }
  _realize(sym, price, frac, now, ev) {
    const p = this.pos[sym];
    const q = p.qty * frac, m = p.margin * frac;
    const dir = p.side === 'long' ? 1 : -1;
    const pnl = (price - p.entry) * q * dir;
    const fee = q * price * this.cfg.fee;
    this.cash += m + pnl - fee;
    p.qty -= q; p.margin -= m;
    this.trades.push({ t: now, sym, ev, side: p.side, price, pnl: pnl - fee });
    if (frac >= 1 || p.qty <= 1e-12) delete this.pos[sym];
  }
  reduce(sym, price, frac, now, ev = 'reduce') { if (this.pos[sym]) this._realize(sym, price, frac, now, ev); }
  close(sym, price, now, ev = 'close') { if (this.pos[sym]) this._realize(sym, price, 1, now, ev); }
  // 청산: 해당 포지션 증거금 전부 손실
  liquidated(sym, price, now) {
    const p = this.pos[sym];
    if (!p) return false;
    if (p.side === 'long' ? price > p.liq : price < p.liq) return false;
    this.trades.push({ t: now, sym, ev: 'liquidated', side: p.side, price: p.liq, pnl: -p.margin });
    delete this.pos[sym];
    return true;
  }
  equity(prices) {
    let e = this.cash;
    for (const [s, p] of Object.entries(this.pos)) {
      const px = prices[s] ?? p.entry;
      e += p.margin + (px - p.entry) * p.qty * (p.side === 'long' ? 1 : -1);
    }
    return e;
  }
}
module.exports = { Paper };
