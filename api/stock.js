// 종목 시세(일봉) 프록시.  /api/stock?symbol=005930&range=1y
//
// 브라우저가 야후 파이낸스를 직접 부르면 CORS 에 막히므로 서버가 대신 받아
// {date, open, high, low, close, volume} 배열로 바꿔 준다. 키는 필요 없다.
//
//   symbol  6자리 숫자면 한국 종목으로 보고 코스피(.KS) → 코스닥(.KQ) 순서로 찾는다.
//           그 밖에는 야후 기호 그대로(AAPL, TSLA, 005930.KS, ^KS11 …).
//   range   3mo 6mo 1y 2y 5y max  (기본 1y)
//
// 성공 응답은 엣지에 10분 캐시한다. 같은 종목을 여러 사람이 봐도 야후 호출은 거의 늘지 않는다.
const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);
const CACHE_SECONDS = 600;
const TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('시세 서버 응답 없음(' + ms + 'ms)')), ms))
  ]);
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;
function dateKey(ts) {
  // 야후는 거래소 현지 시각 기준 타임스탬프를 준다. 날짜만 필요하므로 UTC 로 자른다.
  // 한국·미국 장 시각은 UTC 로 바꿔도 같은 날짜 안에 들어온다(미국 정규장 종료 = UTC 20~21시).
  const d = new Date(ts * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

async function fetchYahoo(symbol, range) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + range + '&interval=1d&includePrePost=false&events=div%2Csplit';
  const res = await withTimeout(fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; chart-viewer/1.0)', Accept: 'application/json' }
  }), TIMEOUT_MS);
  let body = null;
  try { body = await res.json(); } catch (e) { /* 본문이 JSON 이 아니면 아래에서 상태코드로 처리 */ }
  const chart = body && body.chart;
  if (!res.ok || !chart || chart.error || !chart.result || !chart.result[0]) {
    const desc = chart && chart.error && (chart.error.description || chart.error.code);
    const err = new Error(desc || ('HTTP ' + res.status));
    err.status = res.status === 404 ? 404 : (res.status || 502);
    throw err;
  }
  const r = chart.result[0];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const ts = r.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close && q.close[i];
    if (c == null) continue;                       // 휴장·결측
    bars.push({
      date: dateKey(ts[i]),
      open: q.open[i] == null ? c : q.open[i],
      high: q.high[i] == null ? c : q.high[i],
      low: q.low[i] == null ? c : q.low[i],
      close: c,
      volume: q.volume && q.volume[i] != null ? q.volume[i] : 0
    });
  }
  const meta = r.meta || {};
  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || meta.symbol || symbol,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    bars: bars
  };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const raw = String(q.symbol || '').trim().toUpperCase();
  const range = RANGES.has(String(q.range)) ? String(q.range) : '1y';

  if (!raw || !/^[A-Z0-9.^=\-]{1,20}$/.test(raw)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: { message: '종목코드 형식이 올바르지 않습니다. 예) 005930, AAPL, 005930.KS' } });
    return;
  }

  // 한국 6자리 코드는 시장 접미사를 붙여 차례로 시도한다.
  const candidates = /^\d{6}$/.test(raw) ? [raw + '.KS', raw + '.KQ'] : [raw];

  let lastErr = null;
  for (const sym of candidates) {
    try {
      const out = await fetchYahoo(sym, range);
      if (!out.bars.length) { lastErr = new Error('해당 기간에 시세가 없습니다.'); lastErr.status = 404; continue; }
      out.source = '야후 파이낸스 · ' + (out.exchange || '') + (out.currency ? ' ' + out.currency : '');
      out.range = range;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=' + CACHE_SECONDS + ', stale-while-revalidate=' + CACHE_SECONDS * 3);
      res.status(200).json(out);
      return;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status !== 404) break;   // 404 는 다음 후보로, 그 밖의 오류는 바로 알림
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  const status = lastErr && lastErr.status === 404 ? 404 : 502;
  const msg = status === 404
    ? '"' + raw + '" 종목을 찾지 못했습니다. 한국 종목은 6자리 코드(005930), 미국 종목은 티커(AAPL)로 넣어 주세요.'
    : '시세를 가져오지 못했습니다: ' + ((lastErr && lastErr.message) || '알 수 없는 오류');
  res.status(status).json({ error: { message: msg } });
};
