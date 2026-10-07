'use strict';
// Bybit USDT 무기한 주문 어댑터 (원웨이 모드, 격리 마진).
// orders=false(기본)이면 시세·상품정보만 읽고 주문 계열은 로그만 남긴다(드라이런).
const SB = 'sb-';  // 이 봇이 낸 주문의 orderLinkId 접두사. 다른 주문은 건드리지 않는다.
const IGNORE = new Set([110026, 110043, 110025]);  // 마진모드/레버리지 "변경 없음" 계열

const dec = (step) => {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]) + (s.split('e-')[0].split('.')[1] || '').length;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};
const floorStep = (x, step) => Number((Math.floor(x / step + 1e-9) * step).toFixed(dec(step)));
const nearStep = (x, step) => Number((Math.round(x / step) * step).toFixed(dec(step)));

class LiveBroker {
  constructor(client, cfg, { orders = false, log = console.log } = {}) {
    Object.assign(this, { c: client, cfg, orders, log, inst: new Map(), virtual: new Map(), levSet: new Set(), perSymbolIsolated: false });
    this.seq = 0;
  }

  async init() {
    const rows = await this.c.paged('/v5/market/instruments-info', { category: 'linear', limit: '1000' }, false);  // demo 서버도 이 공개 API 를 제공하지만 실패하면 메인넷 값으로 대체해야 할 수 있음(테스트넷에서 확인)
    for (const r of rows) {
      if (r.status !== 'Trading' || r.contractType !== 'LinearPerpetual' || r.quoteCoin !== 'USDT' || r.settleCoin !== 'USDT') continue;
      this.inst.set(r.symbol, {
        tick: +r.priceFilter.tickSize, step: +r.lotSizeFilter.qtyStep, minQty: +r.lotSizeFilter.minOrderQty,
        maxMkt: +(r.lotSizeFilter.maxMktOrderQty || r.lotSizeFilter.maxOrderQty),
        minNotional: +(r.lotSizeFilter.minNotionalValue || 5), maxLev: +r.leverageFilter.maxLeverage,
      });
    }
    if (!this.orders) { this.log(`[dry] USDT 무기한 ${this.inst.size}종목 로드. 주문은 내지 않습니다`); return; }
    try {
      await this.c.post('/v5/account/set-margin-mode', { setMarginMode: 'ISOLATED_MARGIN' });
    } catch (e) {
      if (IGNORE.has(e.code)) { /* 이미 격리 */ }
      else { this.perSymbolIsolated = true; this.log(`계정 마진모드 설정 실패(${e.message}) → 코인별 격리 전환으로 대체`); }
    }
  }

  tradable(sym) {
    const i = this.inst.get(sym);
    return !!i && i.maxLev >= this.cfg.leverage;
  }
  roundPrice(sym, p) { return nearStep(p, this.inst.get(sym).tick); }
  fmtPrice(sym, p) { const i = this.inst.get(sym); return nearStep(p, i.tick).toFixed(dec(i.tick)); }

  // 증거금 × 레버리지 / 가격 을 수량 단위로 내림. 거래소 한도에 안 맞으면 null.
  qtyFor(sym, price, margin) {
    const i = this.inst.get(sym);
    let q = floorStep((margin * this.cfg.leverage) / price, i.step);
    q = Math.min(q, floorStep(i.maxMkt, i.step));
    if (q < i.minQty || q * price < i.minNotional) return null;
    return q.toFixed(dec(i.step));
  }

  async wallet() {
    if (!this.orders) return { equity: this.cfg.seed, available: this.cfg.seed };
    const r = await this.c.get('/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' });
    const coin = r.list[0].coin.find((x) => x.coin === 'USDT') || {};
    return { equity: +coin.equity || 0, available: +(coin.availableToWithdraw || coin.walletBalance) || 0 };
  }

  async _ensureLeverage(sym) {
    if (this.levSet.has(sym)) return;
    const lev = String(this.cfg.leverage);
    if (this.perSymbolIsolated) {
      try { await this.c.post('/v5/position/switch-isolated', { category: 'linear', symbol: sym, tradeMode: 1, buyLeverage: lev, sellLeverage: lev }); }
      catch (e) { if (!IGNORE.has(e.code)) throw e; }
    }
    try { await this.c.post('/v5/position/set-leverage', { category: 'linear', symbol: sym, buyLeverage: lev, sellLeverage: lev }); }
    catch (e) { if (!IGNORE.has(e.code)) throw e; }
    this.levSet.add(sym);
  }

  // 롱=하락 돌파 시 매수(triggerDirection 2), 숏=상승 돌파 시 매도(1). 조건부 시장가.
  async placeTrigger(sym, side, price, margin) {
    const qty = this.qtyFor(sym, price, margin);
    if (!qty) { this.log(`skip ${sym} ${side}: 수량이 거래소 한도(최소/최대/최소금액)에 안 맞음`); return null; }
    const id = `${SB}${sym}-${side === 'long' ? 'L' : 'S'}-${Date.now().toString(36)}${(this.seq++ % 36).toString(36)}`.slice(0, 36);
    const order = {
      category: 'linear', symbol: sym, side: side === 'long' ? 'Buy' : 'Sell', orderType: 'Market', qty,
      triggerPrice: this.fmtPrice(sym, price), triggerDirection: side === 'long' ? 2 : 1, triggerBy: 'LastPrice',
      positionIdx: 0, orderLinkId: id,
    };
    if (!this.orders) { this.virtual.set(id, { symbol: sym, side, price: this.roundPrice(sym, price), id }); this.log(`[dry] trigger ${sym} ${side} @${order.triggerPrice} qty ${qty}`); return id; }
    await this._ensureLeverage(sym);
    await this.c.post('/v5/order/create', order);
    return id;
  }

  async cancel(sym, id) {
    if (!this.orders) { this.virtual.delete(id); return; }
    try { await this.c.post('/v5/order/cancel', { category: 'linear', symbol: sym, orderLinkId: id }); }
    catch (e) { if (![110001, 110008, 110010].includes(e.code)) throw e; }  // 이미 체결/취소됨
  }

  // 대기 중인 이 봇의 조건부 주문들
  async triggers() {
    if (!this.orders) return [...this.virtual.values()];
    const rows = await this.c.paged('/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', orderFilter: 'StopOrder', limit: '50' });
    return rows.filter((o) => o.orderLinkId?.startsWith(SB) && o.orderStatus === 'Untriggered')
      .map((o) => ({ symbol: o.symbol, side: o.side === 'Buy' ? 'long' : 'short', price: +o.triggerPrice, id: o.orderLinkId }));
  }

  async positions() {
    const m = new Map();
    if (!this.orders) return m;
    const rows = await this.c.paged('/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: '200' });
    for (const p of rows) {
      if (!(+p.size > 0)) continue;
      m.set(p.symbol, { side: p.side === 'Buy' ? 'long' : 'short', size: p.size, avgPrice: +p.avgPrice, stopLoss: +p.stopLoss || 0, liqPrice: +p.liqPrice || 0 });
    }
    return m;
  }

  async setStop(sym, price) {
    if (!this.orders) { this.log(`[dry] stop ${sym} @${this.fmtPrice(sym, price)}`); return; }
    await this.c.post('/v5/position/trading-stop', {
      category: 'linear', symbol: sym, stopLoss: this.fmtPrice(sym, price), slTriggerBy: 'LastPrice', tpslMode: 'Full', positionIdx: 0,
    });
  }

  async closeMarket(sym, side, size) {
    if (!this.orders) { this.log(`[dry] close ${sym}`); return; }
    await this.c.post('/v5/order/create', {
      category: 'linear', symbol: sym, side: side === 'long' ? 'Sell' : 'Buy', orderType: 'Market', qty: String(size),
      reduceOnly: true, positionIdx: 0,
    });
  }
}

module.exports = { LiveBroker, floorStep, nearStep, dec, SB };
