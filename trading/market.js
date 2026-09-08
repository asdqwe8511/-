// 시장 데이터. 두 가지 방법으로 만든다.
//   1) makeMarket(...)  씨앗값으로 만드는 가짜 시장. 인터넷 없이 돌린다.
//   2) loadCsvMarket(dir)  진짜 데이터. dir 안의 *.csv 를 종목 하나씩 읽는다.
// 하루 한 개의 봉(시가/고가/저가/종가)과 그날의 펀딩비율을 준다.

// --- 씨앗값 난수. 같은 씨앗이면 항상 같은 시장이 나온다 ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Rng {
  constructor(seed) { this.f = mulberry32(seed >>> 0); }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  normal() { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = this.f();
    while (v === 0) v = this.f();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// 국면(장세). 오래 이어지다가 가끔 바뀐다.
const REGIMES = {
  bull:  { drift:  0.0100, vol: 0.026 },
  bear:  { drift: -0.0115, vol: 0.034 },
  chop:  { drift:  0.0000, vol: 0.019 },
};
const REGIME_KEYS = ['bull', 'bear', 'chop'];

const MARKET_DEFAULTS = {
  seed: 1,
  days: 200,
  symbolCount: 8,
  stay: 0.94,          // 오늘 국면이 내일도 이어질 확률
  crashChance: 0.015,  // 시장 전체가 하루에 크게 빠질 확률
  pumpChance: 0.010,
  jumpChance: 0.020,   // 종목 하나가 혼자 튀거나 빠질 확률
  fundingBase: 0.0001, // 하루 기준 펀딩(양수면 롱이 숏에게 낸다)
  fundingSwing: 0.0011,
  // 크게 빠진 다음 얼마나 되돌리는가. 무손절 전략의 생명줄이다.
  // 0 이면 빠진 채로 간다. 1 이면 빠진 만큼 며칠에 걸쳐 다 되돌린다.
  reboundStrength: 0.35,
  reboundDays: 4,
  reboundTrigger: -0.09, // 이보다 크게 빠진 날부터 되돌림이 예약된다
};

function makeMarket(opts = {}) {
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && !Number.isNaN(v)));
  const o = { ...MARKET_DEFAULTS, ...given };
  const rng = new Rng(o.seed);

  // 1) 국면을 하루씩 정한다
  const regime = [];
  let cur = 'chop';
  for (let t = 0; t < o.days; t++) {
    if (rng.next() > o.stay) cur = REGIME_KEYS[Math.floor(rng.next() * 3)];
    regime.push(cur);
  }

  // 2) 시장 전체의 하루 수익률(비트코인 같은 대장 역할)
  //    크게 빠진 날은 며칠에 걸쳐 일부를 되돌린다(reboundStrength).
  const factor = [];
  const rebound = new Array(o.days + o.reboundDays + 1).fill(0);
  for (let t = 0; t < o.days; t++) {
    const r = REGIMES[regime[t]];
    let x = r.drift + r.vol * rng.normal();
    if (regime[t] !== 'bull' && rng.next() < o.crashChance) x -= rng.range(0.08, 0.20);
    if (regime[t] === 'bull' && rng.next() < o.pumpChance) x += rng.range(0.08, 0.16);
    if (x < o.reboundTrigger && o.reboundStrength > 0) {
      const back = (-x * o.reboundStrength) / o.reboundDays;
      for (let k = 1; k <= o.reboundDays; k++) rebound[t + k] += back;
    }
    factor.push(x + rebound[t]);
  }

  // 3) 종목별로 대장을 따라가되 저마다 따로 논다
  const symbols = [];
  const bars = {};
  const funding = {};
  for (let i = 0; i < o.symbolCount; i++) {
    const sym = 'ALT' + String(i + 1).padStart(2, '0');
    symbols.push(sym);
    const beta = rng.range(0.7, 1.8);
    const idio = rng.range(0.022, 0.045);
    let price = rng.range(0.5, 120);
    const rows = [];
    const closes = [];
    for (let t = 0; t < o.days; t++) {
      let ret = beta * factor[t] + idio * rng.normal();
      if (rng.next() < o.jumpChance) {
        const up = regime[t] === 'bull' ? 0.6 : regime[t] === 'bear' ? 0.3 : 0.5;
        ret += (rng.next() < up ? 1 : -1) * rng.range(0.05, 0.17);
      }
      ret = clamp(ret, -0.55, 0.80);
      const prev = price;
      price = Math.max(prev * (1 + ret), prev * 0.05);
      const open = prev * (1 + 0.15 * idio * rng.normal());
      const span = Math.abs(ret) * rng.range(0.6, 1.5) + rng.range(0.005, 0.025);
      const hi = Math.max(open, price) * (1 + span * rng.range(0.2, 0.9));
      const lo = Math.min(open, price) * (1 - span * rng.range(0.2, 0.9));
      rows.push({ o: open, h: hi, l: Math.max(lo, 1e-9), c: price });
      closes.push(price);
    }
    bars[sym] = rows;
    // 펀딩비는 추세를 따라간다. 오르는 중이면 롱이 낸다.
    funding[sym] = closes.map((c, t) => {
      const back = closes[Math.max(0, t - 5)];
      const mom = back > 0 ? c / back - 1 : 0;
      return clamp(o.fundingBase + o.fundingSwing * Math.tanh(mom / 0.15), -0.0025, 0.0025);
    });
  }

  return { days: o.days, symbols, bars, funding, regime, factor, seed: o.seed, synthetic: true };
}

// --- 진짜 데이터 읽기 ---
// dir/BTCUSDT.csv 처럼 종목당 파일 하나. 첫 줄은 머리글.
// date,open,high,low,close[,funding]  (funding 은 그날 전체 비율, 없으면 0.0001)
function loadCsvMarket(dir) {
  const fs = require('fs');
  const path = require('path');
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
  if (!files.length) throw new Error(dir + ' 안에 csv 가 없습니다');
  const symbols = [];
  const bars = {};
  const funding = {};
  let days = Infinity;
  for (const f of files) {
    const sym = path.basename(f, path.extname(f));
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\r?\n/);
    const head = lines[0].toLowerCase().split(',').map((s) => s.trim());
    const at = (name) => head.indexOf(name);
    const [io, ih, il, ic, ifund] = [at('open'), at('high'), at('low'), at('close'), at('funding')];
    if (io < 0 || ih < 0 || il < 0 || ic < 0) throw new Error(f + ': open/high/low/close 열이 필요합니다');
    const rows = [], fund = [];
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      const bar = { o: +p[io], h: +p[ih], l: +p[il], c: +p[ic] };
      if (!(bar.o > 0 && bar.h > 0 && bar.l > 0 && bar.c > 0)) continue;
      rows.push(bar);
      fund.push(ifund >= 0 && p[ifund] !== undefined && p[ifund] !== '' ? +p[ifund] : 0.0001);
    }
    symbols.push(sym); bars[sym] = rows; funding[sym] = fund;
    days = Math.min(days, rows.length);
  }
  return { days, symbols, bars, funding, regime: null, factor: null, seed: null, synthetic: false };
}

module.exports = { makeMarket, loadCsvMarket, Rng, MARKET_DEFAULTS };
