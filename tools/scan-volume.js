// 거래량은 평소의 N배 이상 터졌는데 가격은 별로 안 오른 코인 찾기 (업비트 원화 마켓).
//   node tools/scan-volume.js [--mult 3] [--max-rise 3] [--days 20] [--min-krw 1000000000] [--include-down]
// 키 없이 공개 시세 API 만 씁니다. 오늘 거래대금은 아직 하루가 덜 지났을 수 있어
// (업비트 일봉은 09:00 KST 기준) 시간이 이를수록 배수가 낮게 나옵니다.

const API = 'https://api.upbit.com/v1';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const MULT = opt('mult', 3);
const MAX_RISE = opt('max-rise', 3) / 100;
const DAYS = opt('days', 20);
const MIN_KRW = opt('min-krw', 1e9); // 오늘 거래대금이 이보다 작은 잡코인은 뺀다
const INCLUDE_DOWN = args.includes('--include-down');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path);
    if (res.status === 429) { await sleep(500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${path} → 요청 제한(429)이 계속됩니다`);
}

async function main() {
  const markets = (await get('/market/all')).filter((m) => m.market.startsWith('KRW-'));
  const names = Object.fromEntries(markets.map((m) => [m.market, m.korean_name]));
  const codes = markets.map((m) => m.market);

  // 1차: 현재가 일괄 조회로 상승률·거래대금 조건부터 걸러 일봉 호출 수를 줄인다.
  const tickers = await get('/ticker?markets=' + codes.join(','));
  const pool = tickers.filter((t) => {
    const r = t.signed_change_rate;
    return r < MAX_RISE && (INCLUDE_DOWN || r >= 0) && t.acc_trade_price_24h >= MIN_KRW;
  });

  // 2차: 후보만 일봉을 받아 평소 거래대금과 비교.
  const hits = [];
  for (const t of pool) {
    const candles = await get(`/candles/days?market=${t.market}&count=${DAYS + 1}`);
    await sleep(120); // 초당 10회 제한 안쪽
    const past = candles.slice(1);
    if (past.length < DAYS / 2) continue; // 신규 상장 등 비교할 이력이 부족
    const avg = past.reduce((s, c) => s + c.candle_acc_trade_price, 0) / past.length;
    const today = candles[0].candle_acc_trade_price;
    const ratio = today / avg;
    if (ratio >= MULT) {
      hits.push({ t, ratio, today, avg });
    }
  }
  hits.sort((a, b) => b.ratio - a.ratio);

  console.log(`업비트 KRW ${codes.length}종목 중 현재가 후보 ${pool.length}개 확인`);
  console.log(`조건: 거래대금 ${DAYS}일 평균의 ${MULT}배 이상, 전일 대비 ${INCLUDE_DOWN ? '' : '0% 이상 '}${MAX_RISE * 100}% 미만\n`);
  if (!hits.length) { console.log('해당 종목 없음'); return; }

  const eok = (n) => (n / 1e8).toFixed(1) + '억';
  console.log('종목'.padEnd(18) + '배수'.padStart(8) + '등락률'.padStart(9) + '오늘 거래대금'.padStart(16) + '평소 평균'.padStart(14));
  for (const { t, ratio, today, avg } of hits) {
    const label = `${names[t.market]}(${t.market.slice(4)})`;
    console.log(
      label.padEnd(18) +
      (ratio.toFixed(1) + '배').padStart(8) +
      ((t.signed_change_rate * 100).toFixed(2) + '%').padStart(9) +
      eok(today).padStart(16) +
      eok(avg).padStart(14)
    );
  }
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1); });
