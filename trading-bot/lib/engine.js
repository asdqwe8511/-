'use strict';
const { newState, step } = require('./strategy');

// 전략(step) + 브로커를 묶는다. 백테스트와 실시간 모의가 같은 엔진을 쓴다.
class Engine {
  constructor(cfg, broker) {
    this.cfg = cfg;
    this.broker = broker;
    this.st = {};
    this.levels = {};
    this.log = [];
  }
  setLevels(sym, lv) { this.levels[sym] = lv; }
  state(sym) { return (this.st[sym] ||= newState()); }

  onPrice(sym, price, now) {
    const st = this.state(sym), b = this.broker, cfg = this.cfg;
    if (b.liquidated(sym, price, now)) {          // 규칙5: 스탑이 없으니 청산이 곧 손절
      this.st[sym] = { ...newState(), cooldownUntil: now + cfg.cooldownMs };
      return;
    }
    for (const a of step(st, price, now, cfg, this.levels[sym])) {
      if (a.type === 'ENTER') {
        if (b.openCount() >= cfg.maxOpen) continue;
        const p = b.open(sym, a.side, a.level, cfg.seed / cfg.entryDivisor, now);
        if (p) Object.assign(st, { phase: 'OPEN', side: a.side, entry: p.entry, peak: p.entry, openedAt: now });
      } else if (a.type === 'CLOSE') {
        b.close(sym, price, now, a.reason);
        this.st[sym] = { ...newState(), cooldownUntil: now + cfg.cooldownMs };
      }
    }
  }
}
module.exports = { Engine };
