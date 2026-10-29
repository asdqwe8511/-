// 바이낸스 USDⓈ-M 선물 "테스트넷" 클라이언트. 의존성 없이 fetch + crypto 만 쓴다.
//
// 일부러 테스트넷 주소만 받는다. 실계좌 주소를 넣으면 생성 단계에서 예외를 던진다.
// 키는 환경변수에서만 읽고 로그·예외 메시지에 싣지 않는다.
const crypto = require('crypto');

const TESTNET = 'https://testnet.binancefuture.com';
const MAINNET_PUBLIC = 'https://fapi.binance.com';       // 시세 읽기 전용(키 없음, 주문 불가)

function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

function qs(params) {
  return Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&');
}

/** 공개 시세(키 없음). 닫힌 봉만 쓰는 쪽에서 걸러 내므로 진행 중인 봉이 섞여도 된다. */
async function publicKlines(symbol, interval, limit, opts) {
  const base = (opts && opts.base) || MAINNET_PUBLIC, f = (opts && opts.fetch) || fetch;
  const r = await f(base + '/fapi/v1/klines?' + qs({ symbol, interval, limit }));
  if (!r.ok) throw new Error('klines HTTP ' + r.status);
  return (await r.json()).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

function createClient(cfg) {
  const base = cfg.baseUrl || TESTNET;
  if (base.replace(/\/+$/, '') !== TESTNET) throw new Error('테스트넷 주소(' + TESTNET + ')만 허용합니다.');
  if (!cfg.apiKey || !cfg.apiSecret) throw new Error('BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET 이 필요합니다.');
  const f = cfg.fetch || fetch;
  const recv = 5000;
  let offset = 0;                                           // 서버 시각과의 차이(ms)

  async function call(method, path, params, signed) {
    const p = Object.assign({}, params);
    if (signed) { p.recvWindow = recv; p.timestamp = Date.now() + offset; }
    let q = qs(p);
    if (signed) q += '&signature=' + sign(q, cfg.apiSecret);
    const url = base + path + (q ? '?' + q : '');
    const r = await f(url, { method, headers: { 'X-MBX-APIKEY': cfg.apiKey } });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 200) }; }
    if (!r.ok) { const err = new Error('Binance ' + method + ' ' + path + ' → ' + r.status + ' ' + (body.msg || body.raw || '')); err.code = body.code; err.status = r.status; throw err; }
    return body;
  }

  return {
    baseUrl: base,
    async syncTime() { const t = await call('GET', '/fapi/v1/time', {}, false); offset = t.serverTime - Date.now(); return offset; },
    async exchangeFilters(symbol) {
      const info = await call('GET', '/fapi/v1/exchangeInfo', {}, false);
      const s = info.symbols.find(x => x.symbol === symbol);
      if (!s) throw new Error('심볼 없음: ' + symbol);
      const get = t => s.filters.find(x => x.filterType === t) || {};
      return { stepSize: +get('LOT_SIZE').stepSize, minQty: +get('LOT_SIZE').minQty, tickSize: +get('PRICE_FILTER').tickSize,
               minNotional: +(get('MIN_NOTIONAL').notional || 0) };
    },
    async account() {
      const a = await call('GET', '/fapi/v2/account', {}, true);
      return { wallet: +a.totalWalletBalance, equity: +a.totalMarginBalance, available: +a.availableBalance };
    },
    async dualSide() { return (await call('GET', '/fapi/v1/positionSide/dual', {}, true)).dualSidePosition === true; },
    async position(symbol) {
      const rows = await call('GET', '/fapi/v2/positionRisk', { symbol }, true);
      const row = rows.find(r => r.positionSide === 'BOTH') || rows[0];
      return row ? { qty: +row.positionAmt, entryPrice: +row.entryPrice, markPrice: +row.markPrice } : { qty: 0, entryPrice: 0, markPrice: 0 };
    },
    async price(symbol) { return +(await call('GET', '/fapi/v1/ticker/price', { symbol }, false)).price; },
    openOrders(symbol) { return call('GET', '/fapi/v1/openOrders', { symbol }, true); },
    cancelAll(symbol) { return call('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true); },
    async setLeverage(symbol, leverage) { return call('POST', '/fapi/v1/leverage', { symbol, leverage }, true); },
    async setIsolated(symbol) {
      try { await call('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }, true); }
      catch (e) { if (e.code !== -4046) throw e; }          // -4046: 이미 격리
    },
    marketOrder(symbol, side, qty, reduceOnly, clientId) {
      return call('POST', '/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty, reduceOnly: reduceOnly ? 'true' : undefined, newClientOrderId: clientId }, true);
    },
    /** 서버에 걸어 두는 손절. 프로그램이 죽어도 남고, 수량을 지정하지 않아 추가·감축 뒤에도 그대로 유효하다. */
    stopOrder(symbol, side, stopPrice, clientId) {
      return call('POST', '/fapi/v1/order', { symbol, side, type: 'STOP_MARKET', stopPrice, closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: clientId }, true);
    }
  };
}

module.exports = { createClient, publicKlines, sign, qs, TESTNET, MAINNET_PUBLIC };
