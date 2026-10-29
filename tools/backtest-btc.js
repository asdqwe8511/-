#!/usr/bin/env node
// 비트코인 일봉으로 1:2:6 분할매매를 백테스트하고, 선물(롱·숏·레버리지)에서도 같은 규칙이
// 통하는지 비교한다. 바이낸스 공개 시세(키 불필요)를 받아 오거나, CSV 를 직접 읽는다.
//
//   node tools/backtest-btc.js                       # 현물 BTCUSDT 일봉 최근 6년 + 선물 비교
//   node tools/backtest-btc.js --years 8 --risk 1    # 기간·거래당 위험(%) 바꾸기
//   node tools/backtest-btc.js --interval 4h         # 4시간봉(펀딩·기간은 알아서 맞춤)
//   node tools/backtest-btc.js --csv btc.csv         # time,open,high,low,close (time=ms 또는 날짜)
//
// 이 도구는 과거 데이터에 규칙을 돌려 볼 뿐 앞으로의 수익을 말해 주지 않는다.
const fs = require('fs');
const E = require('../position-engine.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const YEARS = +arg('years', 6), RISK = +arg('risk', 2), INTERVAL = arg('interval', '1d'), SYMBOL = arg('symbol', 'BTCUSDT');
const LEV = +arg('lev', 3), CSV = arg('csv', null), FEE_SPOT = +arg('fee-spot', 0.1), FEE_FUT = +arg('fee-fut', 0.05);
const BAR_H = { '1h': 1, '2h': 2, '4h': 4, '6h': 6, '12h': 12, '1d': 24 }[INTERVAL] || 24;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url.split('?')[0] + ' → HTTP ' + r.status);
  return r.json();
}

async function klines(base, path, symbol, interval, since) {
  const out = []; let from = since;
  for (;;) {
    const rows = await getJson(base + path + '?symbol=' + symbol + '&interval=' + interval + '&startTime=' + from + '&limit=1000');
    if (!rows.length) break;
    for (const k of rows) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    from = rows[rows.length - 1][0] + 1;
    if (rows.length < 1000) break;
  }
  return out;
}

async function avgFunding(since) {
  const rates = []; let from = since;
  for (;;) {
    const rows = await getJson('https://fapi.binance.com/fapi/v1/fundingRate?symbol=' + SYMBOL + '&startTime=' + from + '&limit=1000');
    if (!rows.length) break;
    rows.forEach(r => rates.push(+r.fundingRate * 100));
    from = rows[rows.length - 1].fundingTime + 1;
    if (rows.length < 1000) break;
  }
  return rates.length ? { mean: rates.reduce((a, b) => a + b, 0) / rates.length, n: rates.length } : null;
}

function readCsv(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(l => l.split(','));
  const out = [];
  for (const r of rows) {
    const t = /^\d+$/.test(r[0]) ? +r[0] : Date.parse(r[0]);
    const o = +r[1], h = +r[2], l = +r[3], c = +r[4];
    if (isFinite(t) && isFinite(o) && isFinite(c)) out.push({ t, o, h, l, c });   // 머리글 줄은 자연히 걸러진다
  }
  return out.sort((a, b) => a.t - b.t);
}

const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d === undefined ? 1 : d) : '—');
function row(label, r) {
  const s = r.stats;
  console.log('  ' + label.padEnd(26) + String(s.trades).padStart(5) + f(s.winRatePct).padStart(8) + '%' + f(s.expectancyR, 2).padStart(8) +
    f(s.profitFactor, 2).padStart(7) + f(s.totalReturnPct).padStart(10) + '%' + f(s.maxDrawdownPct).padStart(8) + '%' +
    ('  ' + s.stageReach.join('/')).padEnd(12) + String(s.liquidations).padStart(4));
}

(async () => {
  let spot, fut = null, funding = null;
  if (CSV) {
    spot = readCsv(CSV); fut = spot;
    console.log('CSV ' + CSV + ' · 캔들 ' + spot.length + '개');
  } else {
    const since = Date.now() - YEARS * 365.25 * 864e5;
    console.log('바이낸스 ' + SYMBOL + ' ' + INTERVAL + ' · 최근 ' + YEARS + '년 내려받는 중...');
    spot = await klines('https://api.binance.com', '/api/v3/klines', SYMBOL, INTERVAL, since);
    try { fut = await klines('https://fapi.binance.com', '/fapi/v1/klines', SYMBOL, INTERVAL, since); funding = await avgFunding(since); }
    catch (e) { console.log('(선물 시세를 못 받아 현물 시세로 선물 규칙만 돌립니다: ' + e.message + ')'); fut = spot; }
  }
  const t0 = new Date(spot[0].t).toISOString().slice(0, 10), t1 = new Date(spot[spot.length - 1].t).toISOString().slice(0, 10);
  console.log('기간 ' + t0 + ' ~ ' + t1 + ' · 거래당 위험 ' + RISK + '% · 시작 자산 10,000');
  if (funding) console.log('펀딩비 평균 ' + funding.mean.toFixed(4) + '% / 8시간 (' + funding.n + '회) — 롱이 내고 숏이 받는 쪽으로 반영');
  console.log('\n  ' + '시나리오'.padEnd(24) + '거래'.padStart(5) + '승률'.padStart(9) + '기대R'.padStart(8) + 'PF'.padStart(7) + '총수익'.padStart(11) + 'MDD'.padStart(9) + '  1/2/3단계'.padEnd(12) + '청산');
  const base = { riskPct: RISK, barHours: BAR_H };
  const fr = funding ? funding.mean : 0.01;
  const groups = [
    ['현물 롱 (1배, 수수료 ' + FEE_SPOT + '%)', spot, { side: 'long', leverage: 1, feePct: FEE_SPOT }],
    ['선물 롱 (' + LEV + '배)', fut, { side: 'long', leverage: LEV, feePct: FEE_FUT, fundingPer8hPct: fr }],
    ['선물 숏 (' + LEV + '배)', fut, { side: 'short', leverage: LEV, feePct: FEE_FUT, fundingPer8hPct: fr }]
  ];
  let bh = null;
  for (const [name, data, o] of groups) {
    console.log('\n[' + name + ']');
    for (const [label, mode] of [['1:2:6 분할', 'ladder'], ['한 번에 진입', 'allin'], ['물타기(신호 없이)', 'avgdown']]) {
      const r = E.backtest(data, Object.assign({}, base, o, { mode }));
      row(label, r);
      bh = r.stats;                                     // 단순 보유는 방향과 무관하게 롱 기준이라 어느 결과에서 꺼내도 같다
    }
  }
  console.log('\n  단순 보유(현물 롱, 같은 기간): ' + f(bh.buyHoldReturnPct) + '%   ← 위 표 수익률은 위험을 ' + RISK + '%로 묶은 전략이라 직접 비교용이 아니라 참고용');
  console.log('\n읽는 법: 기대R = 거래 1건이 평균 몇 R(=위험으로 정한 손실액) 을 남기나 · PF = 총이익/총손실 · MDD = 최대 낙폭');
  console.log('        1/2/3단계 = 각 단계까지 들어간 거래 수 · 청산 = 손절보다 먼저 강제청산된 횟수');
})().catch(e => { console.error('실패: ' + e.message + '\n네트워크가 막혀 있으면 --csv 로 직접 받은 시세 파일을 넣으세요.'); process.exit(1); });
