'use strict';
// 키가 필요 없는 공개 시세 API만 쓴다. (주문 API는 아직 없음)
let BASE = 'https://api.bybit.com/v5/market';
// 테스트넷에서는 시세도 테스트넷 것을 써야 가격이 맞는다.
// 데모(연습모드)는 실제 시세를 쓰므로 공개 시세는 메인넷 것을 읽는다.
const setEnv = (env) => { BASE = `https://${env === 'testnet' ? 'api-testnet' : 'api'}.bybit.com/v5/market`; };

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
  return rows.filter((x) => /^[A-Z0-9]+USDT$/.test(x.symbol)) // USDT 정산 무기한만 (USDC·만기물 제외)
    .map((x) => ({ symbol: x.symbol, price: +x.lastPrice, turnover: +x.turnover24h }));
}

module.exports = { klines, tickers, setEnv };
