'use strict';
// 키가 필요 없는 공개 시세 API만 쓴다. (주문 API는 아직 없음)
const BASE = 'https://api.bybit.com/v5/market';

async function get(path, params) {
  const url = `${BASE}/${path}?${new URLSearchParams({ category: 'linear', ...params })}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(`bybit ${path}: ${j.retMsg}`);
  return j.result.list;
}

// interval: 'D' | '60' | ... 오래된 순으로 반환
async function klines(symbol, interval, limit = 1000) {
  const rows = await get('kline', { symbol, interval, limit: Math.min(limit, 1000) });
  return rows.reverse().map(([t, o, h, l, c, v]) => ({ t: +t, o: +o, h: +h, l: +l, c: +c, v: +v }));
}

async function tickers() {
  const rows = await get('tickers', {});
  return rows.filter((x) => x.symbol.endsWith('USDT'))
    .map((x) => ({ symbol: x.symbol, price: +x.lastPrice, turnover: +x.turnover24h }));
}

module.exports = { klines, tickers };
