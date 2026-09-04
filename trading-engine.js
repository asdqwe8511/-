// 차트 기법 계산 엔진.
//
// 브라우저(<script src="/trading-engine.js"> → window.TradingEngine)와
// 노드(require('./trading-engine.js'))가 같은 파일을 쓴다. DOM 을 건드리지 않는다.
//
// 구조
//   parse*      CSV/JSON 텍스트 → 봉 배열 [{date, open, high, low, close, volume}]
//   ind.*       지표 계산. 입력 길이와 같은 배열을 돌려주고, 아직 계산이 안 되는
//               앞부분은 null 로 채운다(차트가 그 구간을 비워 두면 된다).
//   TECHNIQUES  화면의 체크박스 한 줄 = 여기 항목 하나. 새 기법은 여기에만 더하면
//               체크박스·파라미터 입력·차트 표시·신호 목록이 전부 따라온다.
//   buildStudy  체크된 기법들을 한 번에 계산해 차트가 그릴 수 있는 형태로 묶는다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradingEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── 데이터 읽기 ─────────────────────────

  const HEADER_ALIASES = {
    date:   ['date', 'datetime', 'time', 'timestamp', '날짜', '일자', '일시', '기준일자', '거래일', '거래일자', '년월일'],
    open:   ['open', 'opening', '시가', '시작가', '시가(원)'],
    high:   ['high', '고가', '고가(원)', '최고가'],
    low:    ['low', '저가', '저가(원)', '최저가'],
    close:  ['close', 'closing', 'price', '종가', '종가(원)', '현재가', '현재가(원)', '종가 '],
    adj:    ['adjclose', 'adj close', 'adjusted close', '수정종가'],
    volume: ['volume', 'vol', '거래량', '거래량(주)', '체결량']
  };

  function normHeader(h) {
    return String(h || '').replace(/^﻿/, '').replace(/["']/g, '').trim().toLowerCase();
  }

  function matchHeader(h) {
    const n = normHeader(h);
    for (const key of Object.keys(HEADER_ALIASES)) {
      if (HEADER_ALIASES[key].some((a) => a === n || a.replace(/\s/g, '') === n.replace(/\s/g, ''))) return key;
    }
    // "종가(수정)" 처럼 괄호가 붙은 변형
    const bare = n.replace(/\(.*?\)/g, '').trim();
    for (const key of Object.keys(HEADER_ALIASES)) {
      if (HEADER_ALIASES[key].some((a) => a === bare)) return key;
    }
    return null;
  }

  function toNumber(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/^﻿/, '').replace(/["'\s,원$₩]/g, '').replace(/^\+/, '');
    if (s === '' || s === '-' || /^n\/?a$/i.test(s)) return NaN;
    return Number(s);
  }

  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  // 여러 모양의 날짜를 YYYY-MM-DD(시각이 있으면 뒤에 " HH:MM") 로 맞춘다.
  function toDateKey(v) {
    if (v == null) return null;
    if (typeof v === 'number') {
      // 유닉스 초/밀리초
      const ms = v > 1e11 ? v : v * 1000;
      const d = new Date(ms);
      if (isNaN(d.getTime())) return null;
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    let s = String(v).replace(/^﻿/, '').replace(/["']/g, '').trim();
    if (!s) return null;
    let m;
    if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s))) {
      const base = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
      return m[4] ? base + ' ' + pad2(+m[4]) + ':' + m[5] : base;
    }
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return m[1] + '-' + m[2] + '-' + m[3];
    if ((m = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(s))) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) {
      // 미국식 MM/DD/YYYY 로 본다(한국 자료는 거의 YYYY 로 시작한다).
      return m[3] + '-' + pad2(+m[1]) + '-' + pad2(+m[2]);
    }
    if (/^\d{9,13}$/.test(s)) return toDateKey(Number(s));
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return null;
  }

  function detectDelimiter(line) {
    const cands = [',', '\t', ';', '|'];
    let best = ',', bestN = -1;
    cands.forEach((c) => {
      const n = line.split(c).length - 1;
      if (n > bestN) { best = c; bestN = n; }
    });
    return best;
  }

  function splitLine(line, delim) {
    // 따옴표 안의 구분자는 건너뛴다("1,234" 같은 숫자).
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { q = !q; continue; }
      if (ch === delim && !q) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function finalizeBars(rows) {
    const byDate = new Map();
    rows.forEach((r) => {
      if (!r.date || !isFinite(r.close)) return;
      if (!isFinite(r.open)) r.open = r.close;
      if (!isFinite(r.high)) r.high = Math.max(r.open, r.close);
      if (!isFinite(r.low)) r.low = Math.min(r.open, r.close);
      if (!isFinite(r.volume)) r.volume = 0;
      r.high = Math.max(r.high, r.open, r.close);
      r.low = Math.min(r.low, r.open, r.close);
      byDate.set(r.date, r);       // 같은 날짜가 두 번 오면 뒤의 것이 이긴다
    });
    return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  function parseCsv(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) return [];
    const delim = detectDelimiter(lines[0]);
    const first = splitLine(lines[0], delim);
    const mapped = first.map(matchHeader);
    let cols, start;
    if (mapped.some((k) => k !== null)) {
      cols = mapped; start = 1;
    } else {
      // 헤더가 없으면 날짜,시가,고가,저가,종가,거래량 순서로 본다.
      cols = ['date', 'open', 'high', 'low', 'close', 'volume']; start = 0;
    }
    const idx = {};
    cols.forEach((k, i) => { if (k && !(k in idx)) idx[k] = i; });
    if (!('date' in idx)) throw new Error('날짜 열을 찾지 못했습니다. 첫 줄에 "날짜" 또는 "date" 가 있어야 합니다.');
    if (!('close' in idx) && !('adj' in idx)) throw new Error('종가 열을 찾지 못했습니다. 첫 줄에 "종가" 또는 "close" 가 있어야 합니다.');
    const closeIdx = 'close' in idx ? idx.close : idx.adj;

    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const c = splitLine(lines[i], delim);
      if (c.length < 2) continue;
      rows.push({
        date: toDateKey(c[idx.date]),
        open: toNumber(c[idx.open]),
        high: toNumber(c[idx.high]),
        low: toNumber(c[idx.low]),
        close: toNumber(c[closeIdx]),
        volume: toNumber(c[idx.volume])
      });
    }
    const bars = finalizeBars(rows);
    if (!bars.length) throw new Error('읽을 수 있는 행이 없습니다. 날짜와 종가가 숫자로 들어 있는지 확인해 주세요.');
    return bars;
  }

  function parseJson(input) {
    let data = typeof input === 'string' ? JSON.parse(input) : input;
    if (data && !Array.isArray(data)) {
      data = data.bars || data.data || data.rows || data.candles || data.prices || data;
    }
    if (!Array.isArray(data)) throw new Error('JSON 은 봉 배열이거나 {bars:[...]} 모양이어야 합니다.');
    const rows = data.map((r) => {
      if (Array.isArray(r)) {
        return { date: toDateKey(r[0]), open: toNumber(r[1]), high: toNumber(r[2]), low: toNumber(r[3]), close: toNumber(r[4]), volume: toNumber(r[5]) };
      }
      const get = (key) => {
        for (const k of Object.keys(r)) { if (matchHeader(k) === key) return r[k]; }
        return undefined;
      };
      const close = get('close');
      return {
        date: toDateKey(get('date')),
        open: toNumber(get('open')), high: toNumber(get('high')), low: toNumber(get('low')),
        close: toNumber(close !== undefined ? close : get('adj')),
        volume: toNumber(get('volume'))
      };
    });
    const bars = finalizeBars(rows);
    if (!bars.length) throw new Error('JSON 에서 읽을 수 있는 봉이 없습니다.');
    return bars;
  }

  function parseAny(text) {
    const t = String(text).trim();
    if (t[0] === '[' || t[0] === '{') return parseJson(t);
    return parseCsv(t);
  }

  // ───────────────────────── 샘플 데이터 ─────────────────────────

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 추세가 몇 번 바뀌는 그럴듯한 일봉을 만든다. 같은 seed 면 같은 데이터.
  function generateSample(n, seed, endDate) {
    n = n || 300; seed = seed == null ? 7 : seed;
    const rnd = mulberry32(seed);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const bars = [];
    const end = endDate ? new Date(endDate) : new Date();
    // 평일만 쓰기 위해 뒤에서부터 채운다.
    const dates = [];
    const d = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()));
    while (dates.length < n) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) dates.unshift(d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    let price = 50000, drift = 0.0005, vol = 0.018, regimeLeft = 0;
    let prevClose = price;
    for (let i = 0; i < n; i++) {
      if (regimeLeft <= 0) {
        regimeLeft = 25 + Math.floor(rnd() * 50);
        drift = (rnd() - 0.45) * 0.004;
        vol = 0.01 + rnd() * 0.02;
      }
      regimeLeft--;
      const open = prevClose * (1 + gauss() * vol * 0.3);
      const close = open * (1 + drift + gauss() * vol);
      const high = Math.max(open, close) * (1 + Math.abs(gauss()) * vol * 0.6);
      const low = Math.min(open, close) * (1 - Math.abs(gauss()) * vol * 0.6);
      const move = Math.abs(close - open) / open;
      const volume = Math.round((800000 + rnd() * 600000) * (1 + move * 40) * (rnd() < 0.05 ? 3 : 1));
      const tick = (x) => Math.round(x / 100) * 100;
      bars.push({ date: dates[i], open: tick(open), high: tick(high), low: tick(low), close: tick(close), volume: volume });
      prevClose = close;
    }
    return finalizeBars(bars);
  }

  // ───────────────────────── 지표 ─────────────────────────

  const nulls = (n) => new Array(n).fill(null);
  const pluck = (bars, k) => bars.map((b) => b[k]);

  function sma(values, period) {
    const out = nulls(values.length);
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v != null) { sum += v; count++; }
      if (i >= period) {
        const old = values[i - period];
        if (old != null) { sum -= old; count--; }
      }
      if (i >= period - 1 && count === period) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = nulls(values.length);
    const k = 2 / (period + 1);
    let seedSum = 0, seedCount = 0, prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { if (prev == null) { seedSum = 0; seedCount = 0; } continue; }
      if (prev == null) {
        seedSum += v; seedCount++;
        if (seedCount === period) { prev = seedSum / period; out[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function stddev(values, period) {
    const out = nulls(values.length);
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0, ok = true;
      for (let j = i - period + 1; j <= i; j++) { if (values[j] == null) { ok = false; break; } sum += values[j]; }
      if (!ok) continue;
      const mean = sum / period;
      let sq = 0;
      for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) * (values[j] - mean);
      out[i] = Math.sqrt(sq / period);
    }
    return out;
  }

  function bollinger(closes, period, mult) {
    const mid = sma(closes, period), sd = stddev(closes, period);
    return {
      middle: mid,
      upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
      lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i]))
    };
  }

  function rsi(closes, period) {
    const out = nulls(closes.length);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    let ag = gain / period, al = loss / period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function macd(closes, fast, slow, signalP) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const line = ef.map((f, i) => (f == null || es[i] == null ? null : f - es[i]));
    const signal = ema(line, signalP);
    const hist = line.map((m, i) => (m == null || signal[i] == null ? null : m - signal[i]));
    return { macd: line, signal: signal, hist: hist };
  }

  function highest(values, period) {
    const out = nulls(values.length);
    for (let i = period - 1; i < values.length; i++) {
      let m = -Infinity;
      for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j];
      out[i] = m;
    }
    return out;
  }
  function lowest(values, period) {
    const out = nulls(values.length);
    for (let i = period - 1; i < values.length; i++) {
      let m = Infinity;
      for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j];
      out[i] = m;
    }
    return out;
  }

  function stochastic(bars, kPeriod, kSmooth, dPeriod) {
    const hh = highest(pluck(bars, 'high'), kPeriod), ll = lowest(pluck(bars, 'low'), kPeriod);
    const raw = bars.map((b, i) => {
      if (hh[i] == null) return null;
      const range = hh[i] - ll[i];
      return range === 0 ? 50 : ((b.close - ll[i]) / range) * 100;
    });
    const k = kSmooth > 1 ? sma(raw, kSmooth) : raw;
    const d = sma(k, dPeriod);
    return { k: k, d: d };
  }

  function trueRange(bars) {
    return bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
  }

  function atr(bars, period) {
    const tr = trueRange(bars);
    const out = nulls(bars.length);
    if (bars.length < period) return out;
    let s = 0;
    for (let i = 0; i < period; i++) s += tr[i];
    let prev = s / period;
    out[period - 1] = prev;
    for (let i = period; i < bars.length; i++) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  function obv(bars) {
    const out = new Array(bars.length);
    let acc = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i > 0) {
        if (bars[i].close > bars[i - 1].close) acc += bars[i].volume;
        else if (bars[i].close < bars[i - 1].close) acc -= bars[i].volume;
      }
      out[i] = acc;
    }
    return out;
  }

  function cci(bars, period) {
    const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
    const m = sma(tp, period);
    const out = nulls(bars.length);
    for (let i = period - 1; i < bars.length; i++) {
      if (m[i] == null) continue;
      let dev = 0;
      for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
      dev /= period;
      out[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
    }
    return out;
  }

  function ichimoku(bars, tenkanP, kijunP, senkouP) {
    const highs = pluck(bars, 'high'), lows = pluck(bars, 'low');
    const mid = (p) => {
      const hh = highest(highs, p), ll = lowest(lows, p);
      return hh.map((h, i) => (h == null ? null : (h + ll[i]) / 2));
    };
    const tenkan = mid(tenkanP), kijun = mid(kijunP), spanBraw = mid(senkouP);
    const n = bars.length;
    const spanA = nulls(n + kijunP), spanB = nulls(n + kijunP);
    for (let i = 0; i < n; i++) {
      if (tenkan[i] != null && kijun[i] != null) spanA[i + kijunP] = (tenkan[i] + kijun[i]) / 2;
      if (spanBraw[i] != null) spanB[i + kijunP] = spanBraw[i];
    }
    const chikou = nulls(n);
    for (let i = kijunP; i < n; i++) chikou[i - kijunP] = bars[i].close;
    return { tenkan: tenkan, kijun: kijun, spanA: spanA, spanB: spanB, chikou: chikou };
  }

  function parabolicSar(bars, step, max) {
    const n = bars.length, out = nulls(n), dir = nulls(n);
    if (n < 2) return { sar: out, dir: dir };
    let up = bars[1].close >= bars[0].close;
    let sar = up ? bars[0].low : bars[0].high;
    let ep = up ? bars[1].high : bars[1].low;
    let af = step;
    for (let i = 1; i < n; i++) {
      const b = bars[i];
      sar = sar + af * (ep - sar);
      if (up) {
        sar = Math.min(sar, bars[i - 1].low, i > 1 ? bars[i - 2].low : bars[i - 1].low);
        if (b.low < sar) { up = false; sar = ep; ep = b.low; af = step; }
        else if (b.high > ep) { ep = b.high; af = Math.min(max, af + step); }
      } else {
        sar = Math.max(sar, bars[i - 1].high, i > 1 ? bars[i - 2].high : bars[i - 1].high);
        if (b.high > sar) { up = true; sar = ep; ep = b.high; af = step; }
        else if (b.low < ep) { ep = b.low; af = Math.min(max, af + step); }
      }
      out[i] = sar; dir[i] = up ? 1 : -1;
    }
    return { sar: out, dir: dir };
  }

  // 스윙 고점/저점: 좌우 n 개 봉보다 높은(낮은) 봉.
  function swings(bars, n) {
    const highs = [], lows = [];
    for (let i = n; i < bars.length - n; i++) {
      let isH = true, isL = true;
      for (let j = i - n; j <= i + n; j++) {
        if (j === i) continue;
        if (bars[j].high >= bars[i].high) isH = false;
        if (bars[j].low <= bars[i].low) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) highs.push(i);
      if (isL) lows.push(i);
    }
    return { highs: highs, lows: lows };
  }

  // 피봇 포인트(클래식). 직전 기간(일/주/월)의 고가·저가·종가로 이번 기간의 값을 만든다.
  function periodKey(date, mode) {
    const y = +date.slice(0, 4), m = +date.slice(5, 7), d = +date.slice(8, 10);
    if (mode === 'day') return date.slice(0, 10);
    if (mode === 'month') return date.slice(0, 7);
    // ISO 주
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayNum = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
    return dt.getUTCFullYear() + '-W' + pad2(week);
  }

  function pivotPoints(bars, mode) {
    const n = bars.length;
    const keys = bars.map((b) => periodKey(b.date, mode));
    const out = { p: nulls(n), r1: nulls(n), r2: nulls(n), s1: nulls(n), s2: nulls(n) };
    let curKey = null, curH = null, curL = null, curC = null, prev = null;
    for (let i = 0; i < n; i++) {
      if (keys[i] !== curKey) {
        if (curKey !== null) prev = { h: curH, l: curL, c: curC };
        curKey = keys[i]; curH = -Infinity; curL = Infinity;
      }
      curH = Math.max(curH, bars[i].high); curL = Math.min(curL, bars[i].low); curC = bars[i].close;
      if (prev) {
        const p = (prev.h + prev.l + prev.c) / 3;
        out.p[i] = p; out.r1[i] = 2 * p - prev.l; out.s1[i] = 2 * p - prev.h;
        out.r2[i] = p + (prev.h - prev.l); out.s2[i] = p - (prev.h - prev.l);
      }
    }
    return out;
  }

  // 두 선의 교차. +1 위로 뚫음, -1 아래로 뚫음, 0 없음.
  function crossAt(a, b, i) {
    if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return 0;
    if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return 1;
    if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return -1;
    return 0;
  }

  const ind = {
    sma, ema, stddev, bollinger, rsi, macd, highest, lowest, stochastic, trueRange, atr, obv, cci,
    ichimoku, parabolicSar, swings, pivotPoints, crossAt
  };

  // ───────────────────────── 기법 목록 ─────────────────────────
  //
  // 항목 하나의 모양
  //   id      저장·URL 에 쓰는 이름 (바꾸면 저장된 설정이 풀린다)
  //   group   'trend' 차트 위에 겹침 / 'momentum' 아래 패널 / 'signal' 매매 신호 표시
  //   name    체크박스 글자
  //   desc    한 줄 설명 (체크박스 아래 작은 글씨)
  //   params  [{key, label, default, min, max, step, type:'number'|'list'|'select', options}]
  //   compute(bars, p) → { overlays:[...], panel:{...}, markers:[...] }  (없는 것은 생략)
  //
  //   overlay 종류
  //     {kind:'line',  name, color, values, width, dash}
  //     {kind:'band',  name, upper, lower, middle, color}        위·아래 선 + 사이 옅게 칠함
  //     {kind:'cloud', name, a, b, colorUp, colorDown}           a>b 면 colorUp
  //     {kind:'dots',  name, color, values}
  //     {kind:'step',  name, color, values, dash}                계단선(피봇처럼 기간마다 바뀌는 값)
  //     {kind:'levels', name, levels:[{price, label, color, dash}]}  가로선
  //     {kind:'zones', zones:[{from, to, color, label}]}             봉 구간을 옅게 칠함 (패턴 구간)
  //     {kind:'segments', segments:[{from, to, price, color, label, dash}]}  일정 구간의 가로선 (목표가·손절가·목선)
  //     {kind:'paths', paths:[{points:[{index, price}], color, width, dash}]}  꺾은선 (패턴 윤곽)
  //   panel
  //     {name, range:[min,max]|null, series:[{kind:'line'|'hist', name, color, values, width}],
  //      guides:[{value, label, color}]}
  //   marker
  //     {index, type:'buy'|'sell'|'note', text, price}
  //     매매 전략의 진입 마커는 entry·target·stop·outcome 이 더 붙고,
  //     청산 시점에는 type:'target'|'stop'|'expired', exit:true 마커가 하나 더 생긴다.

  const PALETTE = ['#ffb347', '#7c5cff', '#2dd4bf', '#f472b6', '#a3e635', '#38bdf8', '#fb7185', '#c084fc'];

  const num = (p, key, def) => {
    const v = Number(p && p[key]);
    return isFinite(v) && v > 0 ? v : def;
  };
  const list = (p, key, def) => {
    const raw = p && p[key] != null ? String(p[key]) : def;
    const arr = raw.split(/[,\s]+/).map(Number).filter((x) => isFinite(x) && x > 0).map((x) => Math.round(x));
    return arr.length ? arr : def.split(',').map(Number);
  };

  // ── 매매 하나를 끝까지 따라가 보기 ──
  const body = (b) => Math.abs(b.close - b.open);
  const range = (b) => b.high - b.low;
  const upperShadow = (b) => b.high - Math.max(b.open, b.close);
  const lowerShadow = (b) => Math.min(b.open, b.close) - b.low;

  // 진입 뒤 horizon 봉 안에서 목표가와 손절가 중 어느 쪽에 먼저 닿는지.
  // 같은 봉에서 둘 다 닿으면 손절로 친다(보수적으로). 갭으로 건너뛰면 시가로 체결된 것으로 본다.
  function simulateTrade(bars, i, side, target, stop, horizon) {
    const long = side === 'long';
    const end = Math.min(bars.length - 1, i + horizon);
    const entry = bars[i].close;
    const pctOf = (px) => (long ? (px / entry - 1) : (entry / px - 1)) * 100;
    for (let k = i + 1; k <= end; k++) {
      const b = bars[k];
      const hitStop = long ? b.low <= stop : b.high >= stop;
      const hitTarget = long ? b.high >= target : b.low <= target;
      if (hitStop) {
        const px = long ? Math.min(stop, b.open) : Math.max(stop, b.open);
        return { result: 'stop', exitIndex: k, exitPrice: px, pct: pctOf(px), bars: k - i };
      }
      if (hitTarget) {
        const px = long ? Math.max(target, b.open) : Math.min(target, b.open);
        return { result: 'target', exitIndex: k, exitPrice: px, pct: pctOf(px), bars: k - i };
      }
    }
    const lastPx = bars[end].close;
    if (end < i + horizon) return { result: 'open', exitIndex: null, exitPrice: lastPx, pct: pctOf(lastPx), bars: end - i };
    return { result: 'expired', exitIndex: end, exitPrice: lastPx, pct: pctOf(lastPx), bars: end - i };
  }

  const OUTCOME_TEXT = { target: '목표 도달', stop: '손절', expired: '기간 만료', open: '진행 중' };

  // trades: [{index, side:'long'|'short', text, entry, target, stop, horizon, from, path, level, level2, segment}]
  // → 진입·청산 마커와 패턴 구간·윤곽·목표/손절 선을 차트가 그릴 모양으로.
  function assembleTrades(bars, trades, color) {
    const markers = [], zones = [], segments = [], paths = [];
    trades.forEach((t) => {
      if (!(t.index >= 0 && t.index < bars.length) || !isFinite(t.target) || !isFinite(t.stop)) return;
      const out = simulateTrade(bars, t.index, t.side, t.target, t.stop, t.horizon || 30);
      const endIdx = out.exitIndex != null ? out.exitIndex : Math.min(bars.length - 1, t.index + (t.horizon || 30));
      markers.push({
        index: t.index, type: t.side === 'long' ? 'buy' : 'sell', text: t.text + ' 진입', price: t.entry,
        entry: t.entry, target: t.target, stop: t.stop, side: t.side, outcome: out, strategy: true, color: color
      });
      if (out.exitIndex != null) {
        const sign = out.pct >= 0 ? '+' : '';
        markers.push({
          index: out.exitIndex, type: out.result, exit: true, entryIndex: t.index,
          text: OUTCOME_TEXT[out.result] + ' (' + t.text + ' ' + sign + out.pct.toFixed(1) + '%)', price: out.exitPrice,
          place: (t.side === 'long') === (out.result === 'target') ? 'above' : 'below'
        });
      }
      if (t.from != null && t.from < t.index) zones.push({ from: t.from, to: t.index, color: color, label: t.text });
      segments.push({ from: t.index, to: endIdx, price: t.target, color: '#ffd166', label: '목표', dash: [4, 3] });
      segments.push({ from: t.index, to: endIdx, price: t.stop, color: '#9298a8', label: '손절', dash: [2, 3] });
      if (t.level) segments.push({ from: t.level.from, to: t.level.to, price: t.level.price, color: color, label: t.level.label, dash: [6, 3] });
      if (t.level2) segments.push({ from: t.level2.from, to: t.level2.to, price: t.level2.price, color: color, label: t.level2.label, dash: [6, 3] });
      if (t.path) paths.push({ points: t.path, color: color, width: 1.5 });
      if (t.segment) paths.push({ points: t.segment.points, color: color, width: 1, dash: [6, 3], label: t.segment.label });
    });
    const overlays = [];
    if (zones.length) overlays.push({ kind: 'zones', name: '패턴 구간', zones: zones });
    if (paths.length) overlays.push({ kind: 'paths', name: '패턴 윤곽', paths: paths });
    if (segments.length) overlays.push({ kind: 'segments', name: '목표·손절', segments: segments });
    return { overlays: overlays, markers: markers };
  }

  const TECHNIQUES = [
    // ── 추세 (차트 위에 겹침) ──
    {
      id: 'sma', group: 'trend', name: '단순이동평균 (SMA)',
      desc: '기간별 종가 평균. 5·20·60·120일 정배열이면 상승 추세로 본다.',
      params: [{ key: 'periods', label: '기간', default: '5,20,60,120', type: 'list' }],
      compute(bars, p) {
        const closes = pluck(bars, 'close');
        return {
          overlays: list(p, 'periods', '5,20,60,120').map((n, i) => ({
            kind: 'line', name: 'SMA ' + n, color: PALETTE[i % PALETTE.length], values: sma(closes, n), width: 1.2
          }))
        };
      }
    },
    {
      id: 'ema', group: 'trend', name: '지수이동평균 (EMA)',
      desc: '최근 가격에 무게를 더 둔 평균. SMA 보다 방향 전환이 빠르다.',
      params: [{ key: 'periods', label: '기간', default: '12,26', type: 'list' }],
      compute(bars, p) {
        const closes = pluck(bars, 'close');
        return {
          overlays: list(p, 'periods', '12,26').map((n, i) => ({
            kind: 'line', name: 'EMA ' + n, color: PALETTE[(i + 4) % PALETTE.length], values: ema(closes, n), width: 1.2, dash: [4, 3]
          }))
        };
      }
    },
    {
      id: 'bollinger', group: 'trend', name: '볼린저 밴드',
      desc: '이동평균 ± 표준편차×배수. 밴드가 좁아지면 큰 움직임을 앞둔 경우가 많다.',
      params: [
        { key: 'period', label: '기간', default: 20, min: 2, max: 400 },
        { key: 'mult', label: '배수', default: 2, min: 0.5, max: 5, step: 0.1 }
      ],
      compute(bars, p) {
        const bb = bollinger(pluck(bars, 'close'), num(p, 'period', 20), num(p, 'mult', 2));
        return { overlays: [{ kind: 'band', name: '볼린저', upper: bb.upper, lower: bb.lower, middle: bb.middle, color: '#38bdf8' }] };
      }
    },
    {
      id: 'envelope', group: 'trend', name: '엔벨로프',
      desc: '이동평균에서 일정 % 위아래 선. 선에 닿으면 되돌림을 노린다.',
      params: [
        { key: 'period', label: '기간', default: 20, min: 2, max: 400 },
        { key: 'pct', label: '폭 %', default: 6, min: 0.1, max: 50, step: 0.5 }
      ],
      compute(bars, p) {
        const m = sma(pluck(bars, 'close'), num(p, 'period', 20));
        const k = num(p, 'pct', 6) / 100;
        return { overlays: [{ kind: 'band', name: '엔벨로프', upper: m.map((v) => (v == null ? null : v * (1 + k))), lower: m.map((v) => (v == null ? null : v * (1 - k))), middle: m, color: '#c084fc' }] };
      }
    },
    {
      id: 'ichimoku', group: 'trend', name: '일목균형표',
      desc: '전환선·기준선·구름대. 가격이 구름 위면 강세, 아래면 약세.',
      params: [
        { key: 'tenkan', label: '전환', default: 9, min: 2, max: 100 },
        { key: 'kijun', label: '기준', default: 26, min: 2, max: 200 },
        { key: 'senkou', label: '선행B', default: 52, min: 2, max: 400 }
      ],
      compute(bars, p) {
        const r = ichimoku(bars, num(p, 'tenkan', 9), num(p, 'kijun', 26), num(p, 'senkou', 52));
        return {
          overlays: [
            { kind: 'cloud', name: '구름대', a: r.spanA, b: r.spanB, colorUp: 'rgba(45,212,191,0.18)', colorDown: 'rgba(255,84,112,0.18)' },
            { kind: 'line', name: '전환선', color: '#38bdf8', values: r.tenkan, width: 1 },
            { kind: 'line', name: '기준선', color: '#f472b6', values: r.kijun, width: 1 },
            { kind: 'line', name: '후행스팬', color: '#a3e635', values: r.chikou, width: 1, dash: [2, 2] }
          ]
        };
      }
    },
    {
      id: 'psar', group: 'trend', name: '파라볼릭 SAR',
      desc: '점이 가격 아래면 상승, 위로 넘어가면 추세 전환.',
      params: [
        { key: 'step', label: '가속', default: 0.02, min: 0.001, max: 0.5, step: 0.01 },
        { key: 'max', label: '최대', default: 0.2, min: 0.01, max: 1, step: 0.05 }
      ],
      compute(bars, p) {
        const r = parabolicSar(bars, num(p, 'step', 0.02), num(p, 'max', 0.2));
        const markers = [];
        for (let i = 2; i < bars.length; i++) {
          if (r.dir[i] !== r.dir[i - 1] && r.dir[i - 1] != null) {
            markers.push({ index: i, type: r.dir[i] > 0 ? 'buy' : 'sell', text: 'SAR ' + (r.dir[i] > 0 ? '상승 전환' : '하락 전환'), price: bars[i].close });
          }
        }
        return { overlays: [{ kind: 'dots', name: 'SAR', color: '#ffb347', values: r.sar }], markers: markers };
      }
    },
    {
      id: 'donchian', group: 'trend', name: '돈치안 채널',
      desc: '최근 n일 최고가·최저가. 상단 돌파 매수, 하단 이탈 매도(터틀 전략).',
      params: [{ key: 'period', label: '기간', default: 20, min: 2, max: 400 }],
      compute(bars, p) {
        const n = num(p, 'period', 20);
        const up = highest(pluck(bars, 'high'), n), lo = lowest(pluck(bars, 'low'), n);
        return { overlays: [{ kind: 'band', name: '돈치안', upper: up, lower: lo, middle: up.map((u, i) => (u == null ? null : (u + lo[i]) / 2)), color: '#a3e635' }] };
      }
    },
    {
      id: 'pivot', group: 'trend', name: '피봇 포인트',
      desc: '직전 기간 고·저·종가로 만든 지지(S)·저항(R) 선.',
      params: [{ key: 'mode', label: '기간', default: 'month', type: 'select', options: [['day', '일'], ['week', '주'], ['month', '월']] }],
      compute(bars, p) {
        const mode = p && ['day', 'week', 'month'].indexOf(p.mode) >= 0 ? p.mode : 'month';
        const r = pivotPoints(bars, mode);
        return {
          overlays: [
            { kind: 'step', name: 'R2', color: 'rgba(255,84,112,0.7)', values: r.r2, dash: [3, 3] },
            { kind: 'step', name: 'R1', color: 'rgba(255,84,112,0.9)', values: r.r1 },
            { kind: 'step', name: 'P', color: '#ffb347', values: r.p },
            { kind: 'step', name: 'S1', color: 'rgba(76,141,255,0.9)', values: r.s1 },
            { kind: 'step', name: 'S2', color: 'rgba(76,141,255,0.7)', values: r.s2, dash: [3, 3] }
          ]
        };
      }
    },
    {
      id: 'swing', group: 'trend', name: '지지·저항 (스윙 고점·저점)',
      desc: '좌우 n봉보다 높은 고점, 낮은 저점을 찾고 최근 것을 가로선으로 잇는다.',
      params: [
        { key: 'n', label: '좌우 봉수', default: 5, min: 1, max: 50 },
        { key: 'lines', label: '선 개수', default: 2, min: 1, max: 6 }
      ],
      compute(bars, p) {
        const r = swings(bars, num(p, 'n', 5));
        const k = num(p, 'lines', 2);
        const markers = [];
        r.highs.forEach((i) => markers.push({ index: i, type: 'note', text: '스윙 고점', price: bars[i].high, place: 'above', color: '#ff5470' }));
        r.lows.forEach((i) => markers.push({ index: i, type: 'note', text: '스윙 저점', price: bars[i].low, place: 'below', color: '#4c8dff' }));
        const levels = [];
        r.highs.slice(-k).forEach((i) => levels.push({ price: bars[i].high, label: '저항 ' + bars[i].date.slice(5), color: 'rgba(255,84,112,0.8)', dash: [4, 3], from: i }));
        r.lows.slice(-k).forEach((i) => levels.push({ price: bars[i].low, label: '지지 ' + bars[i].date.slice(5), color: 'rgba(76,141,255,0.8)', dash: [4, 3], from: i }));
        return { overlays: [{ kind: 'levels', name: '지지·저항', levels: levels }], markers: markers };
      }
    },

    // ── 모멘텀·거래량 (아래 패널) ──
    {
      id: 'volume', group: 'momentum', name: '거래량',
      desc: '봉 색과 같은 색의 막대. 이동평균선을 함께 그린다.',
      params: [{ key: 'ma', label: '평균', default: 20, min: 1, max: 400 }],
      compute(bars, p) {
        const vols = pluck(bars, 'volume');
        return {
          panel: {
            name: '거래량', range: null, height: 0.8,
            series: [
              { kind: 'hist', name: '거래량', values: vols, colorBy: 'candle' },
              { kind: 'line', name: 'VOL MA ' + num(p, 'ma', 20), color: '#ffb347', values: sma(vols, num(p, 'ma', 20)), width: 1 }
            ],
            guides: []
          }
        };
      }
    },
    {
      id: 'rsi', group: 'momentum', name: 'RSI',
      desc: '0~100. 70 위는 과매수, 30 아래는 과매도로 본다.',
      params: [
        { key: 'period', label: '기간', default: 14, min: 2, max: 200 },
        { key: 'hi', label: '과매수', default: 70, min: 50, max: 99 },
        { key: 'lo', label: '과매도', default: 30, min: 1, max: 50 }
      ],
      compute(bars, p) {
        const r = rsi(pluck(bars, 'close'), num(p, 'period', 14));
        return {
          panel: {
            name: 'RSI ' + num(p, 'period', 14), range: [0, 100],
            series: [{ kind: 'line', name: 'RSI', color: '#c084fc', values: r, width: 1.3 }],
            guides: [{ value: num(p, 'hi', 70), label: String(num(p, 'hi', 70)), color: 'rgba(255,84,112,0.5)' }, { value: num(p, 'lo', 30), label: String(num(p, 'lo', 30)), color: 'rgba(76,141,255,0.5)' }]
          }
        };
      }
    },
    {
      id: 'macd', group: 'momentum', name: 'MACD',
      desc: '빠른 EMA − 느린 EMA. 시그널선을 위로 뚫으면 매수 신호로 본다.',
      params: [
        { key: 'fast', label: '빠름', default: 12, min: 2, max: 200 },
        { key: 'slow', label: '느림', default: 26, min: 3, max: 400 },
        { key: 'signal', label: '시그널', default: 9, min: 2, max: 100 }
      ],
      compute(bars, p) {
        const r = macd(pluck(bars, 'close'), num(p, 'fast', 12), num(p, 'slow', 26), num(p, 'signal', 9));
        return {
          panel: {
            name: 'MACD ' + [num(p, 'fast', 12), num(p, 'slow', 26), num(p, 'signal', 9)].join(','), range: null, zero: true,
            series: [
              { kind: 'hist', name: '히스토그램', values: r.hist, colorBy: 'sign' },
              { kind: 'line', name: 'MACD', color: '#38bdf8', values: r.macd, width: 1.3 },
              { kind: 'line', name: '시그널', color: '#ffb347', values: r.signal, width: 1 }
            ],
            guides: [{ value: 0, label: '0', color: 'rgba(146,152,168,0.5)' }]
          }
        };
      }
    },
    {
      id: 'stoch', group: 'momentum', name: '스토캐스틱',
      desc: '최근 n일 범위에서 종가 위치(%K)와 그 평균(%D). 80 위 과매수, 20 아래 과매도.',
      params: [
        { key: 'k', label: '%K', default: 14, min: 2, max: 200 },
        { key: 'ks', label: '%K 평활', default: 3, min: 1, max: 50 },
        { key: 'd', label: '%D', default: 3, min: 1, max: 50 }
      ],
      compute(bars, p) {
        const r = stochastic(bars, num(p, 'k', 14), num(p, 'ks', 3), num(p, 'd', 3));
        return {
          panel: {
            name: '스토캐스틱', range: [0, 100],
            series: [{ kind: 'line', name: '%K', color: '#38bdf8', values: r.k, width: 1.3 }, { kind: 'line', name: '%D', color: '#ffb347', values: r.d, width: 1 }],
            guides: [{ value: 80, label: '80', color: 'rgba(255,84,112,0.5)' }, { value: 20, label: '20', color: 'rgba(76,141,255,0.5)' }]
          }
        };
      }
    },
    {
      id: 'cci', group: 'momentum', name: 'CCI',
      desc: '평균가격에서 얼마나 벗어났는지. ±100 바깥이면 추세가 강하거나 과열.',
      params: [{ key: 'period', label: '기간', default: 20, min: 2, max: 200 }],
      compute(bars, p) {
        return {
          panel: {
            name: 'CCI ' + num(p, 'period', 20), range: null, zero: true,
            series: [{ kind: 'line', name: 'CCI', color: '#a3e635', values: cci(bars, num(p, 'period', 20)), width: 1.3 }],
            guides: [{ value: 100, label: '100', color: 'rgba(255,84,112,0.5)' }, { value: -100, label: '-100', color: 'rgba(76,141,255,0.5)' }, { value: 0, label: '0', color: 'rgba(146,152,168,0.4)' }]
          }
        };
      }
    },
    {
      id: 'atr', group: 'momentum', name: 'ATR (변동폭)',
      desc: '하루 평균 진폭. 손절 폭을 ATR 의 배수로 정할 때 쓴다.',
      params: [{ key: 'period', label: '기간', default: 14, min: 2, max: 200 }],
      compute(bars, p) {
        return {
          panel: {
            name: 'ATR ' + num(p, 'period', 14), range: null,
            series: [{ kind: 'line', name: 'ATR', color: '#f472b6', values: atr(bars, num(p, 'period', 14)), width: 1.3 }],
            guides: []
          }
        };
      }
    },
    {
      id: 'obv', group: 'momentum', name: 'OBV (누적 거래량)',
      desc: '오른 날 거래량은 더하고 내린 날은 뺀 누적값. 가격보다 먼저 꺾이면 의심.',
      params: [],
      compute(bars) {
        return { panel: { name: 'OBV', range: null, series: [{ kind: 'line', name: 'OBV', color: '#2dd4bf', values: obv(bars), width: 1.3 }], guides: [] } };
      }
    },

    // ── 패턴 · 매매 전략 (진입 → 목표가·손절가 → 결과) ──
    //
    // 아래 기법들은 trade() 로 매매 하나를 만든다. 진입 봉에 ▲▼, 그 뒤로 목표가·손절가
    // 선을 긋고, 실제로 어느 쪽에 먼저 닿았는지(목표 도달 ★ / 손절 ✕ / 기간 만료) 를
    // 뒤 봉들을 따라가며 확인해 그 시점에도 표시를 남긴다.
    {
      id: 'pat_three', group: 'pattern', name: '적삼병 · 흑삼병',
      desc: '양봉(음봉) 셋이 연달아 계단처럼 오르면(내리면) 추세 시작으로 본다. 목표 = 세 봉 높이만큼, 손절 = 첫 봉 아래(위).',
      params: [
        { key: 'body', label: '몸통 비율', default: 0.5, min: 0.1, max: 1, step: 0.05 },
        { key: 'horizon', label: '보유 봉수', default: 40, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const minBody = num(p, 'body', 0.5), horizon = num(p, 'horizon', 40);
        const trades = [];
        let last = -10;
        for (let i = 2; i < bars.length; i++) {
          if (i - last < 3) continue;
          const c = [bars[i - 2], bars[i - 1], bars[i]];
          const bull = c.every((b) => b.close > b.open && body(b) >= minBody * range(b))
            && c[1].close > c[0].close && c[2].close > c[1].close
            && c[1].open >= c[0].open && c[1].open <= c[0].close
            && c[2].open >= c[1].open && c[2].open <= c[1].close;
          const bear = c.every((b) => b.close < b.open && body(b) >= minBody * range(b))
            && c[1].close < c[0].close && c[2].close < c[1].close
            && c[1].open <= c[0].open && c[1].open >= c[0].close
            && c[2].open <= c[1].open && c[2].open >= c[1].close;
          if (!bull && !bear) continue;
          last = i;
          const entry = c[2].close;
          const height = Math.abs(c[2].close - c[0].open);
          trades.push(bull
            ? { index: i, side: 'long', text: '적삼병', entry: entry, target: entry + height, stop: Math.min(c[0].low, c[1].low, c[2].low), from: i - 2, horizon: horizon }
            : { index: i, side: 'short', text: '흑삼병', entry: entry, target: entry - height, stop: Math.max(c[0].high, c[1].high, c[2].high), from: i - 2, horizon: horizon });
        }
        return assembleTrades(bars, trades, '#ffb347');
      }
    },
    {
      id: 'pat_engulf', group: 'pattern', name: '장악형 (상승·하락)',
      desc: '오늘 봉이 어제 봉 몸통을 통째로 감싸면 방향 전환. 손절 = 오늘 봉 반대쪽 끝, 목표 = 손절폭 × 배수.',
      params: [
        { key: 'rr', label: '손익비', default: 2, min: 0.5, max: 10, step: 0.5 },
        { key: 'horizon', label: '보유 봉수', default: 30, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const rr = num(p, 'rr', 2), horizon = num(p, 'horizon', 30);
        const trades = [];
        for (let i = 1; i < bars.length; i++) {
          const a = bars[i - 1], b = bars[i];
          if (body(b) < body(a) * 1.1 || body(b) < range(b) * 0.4) continue;
          if (a.close < a.open && b.close > b.open && b.open <= a.close && b.close >= a.open) {
            const stop = b.low, entry = b.close;
            trades.push({ index: i, side: 'long', text: '상승 장악형', entry: entry, target: entry + rr * (entry - stop), stop: stop, from: i - 1, horizon: horizon });
          } else if (a.close > a.open && b.close < b.open && b.open >= a.close && b.close <= a.open) {
            const stop = b.high, entry = b.close;
            trades.push({ index: i, side: 'short', text: '하락 장악형', entry: entry, target: entry - rr * (stop - entry), stop: stop, from: i - 1, horizon: horizon });
          }
        }
        return assembleTrades(bars, trades, '#f472b6');
      }
    },
    {
      id: 'pat_hammer', group: 'pattern', name: '망치형 · 유성형',
      desc: '긴 꼬리 하나짜리 봉. 하락 뒤 아래꼬리(망치형)는 매수, 상승 뒤 위꼬리(유성형)는 매도. 손절 = 꼬리 끝.',
      params: [
        { key: 'tail', label: '꼬리/몸통', default: 2, min: 1, max: 10, step: 0.5 },
        { key: 'rr', label: '손익비', default: 2, min: 0.5, max: 10, step: 0.5 },
        { key: 'horizon', label: '보유 봉수', default: 30, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const k = num(p, 'tail', 2), rr = num(p, 'rr', 2), horizon = num(p, 'horizon', 30);
        const ma = sma(pluck(bars, 'close'), 10);
        const trades = [];
        for (let i = 1; i < bars.length; i++) {
          const b = bars[i], bd = Math.max(body(b), range(b) * 0.03);
          if (range(b) === 0 || ma[i - 1] == null) continue;
          const up = upperShadow(b), lo = lowerShadow(b);
          const downtrend = bars[i - 1].close < ma[i - 1], uptrend = bars[i - 1].close > ma[i - 1];
          const small = Math.max(bd * 0.6, range(b) * 0.12);     // 반대쪽 꼬리는 이 정도까지만
          if (lo >= k * bd && up <= small && downtrend) {
            const entry = b.close, stop = b.low;
            trades.push({ index: i, side: 'long', text: '망치형', entry: entry, target: entry + rr * (entry - stop), stop: stop, from: i, horizon: horizon });
          } else if (up >= k * bd && lo <= small && uptrend) {
            const entry = b.close, stop = b.high;
            trades.push({ index: i, side: 'short', text: '유성형', entry: entry, target: entry - rr * (stop - entry), stop: stop, from: i, horizon: horizon });
          }
        }
        return assembleTrades(bars, trades, '#c084fc');
      }
    },
    {
      id: 'pat_star', group: 'pattern', name: '샛별형 · 저녁별형',
      desc: '큰 봉 → 작은 봉 → 반대 방향 큰 봉. 세 번째 봉이 첫 봉 몸통 절반을 넘어야 한다. 손절 = 세 봉의 끝.',
      params: [
        { key: 'rr', label: '손익비', default: 2, min: 0.5, max: 10, step: 0.5 },
        { key: 'horizon', label: '보유 봉수', default: 30, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const rr = num(p, 'rr', 2), horizon = num(p, 'horizon', 30);
        const trades = [];
        for (let i = 2; i < bars.length; i++) {
          const a = bars[i - 2], m = bars[i - 1], b = bars[i];
          if (body(a) < range(a) * 0.5 || body(m) > body(a) * 0.35) continue;
          const mid = (a.open + a.close) / 2;
          if (a.close < a.open && b.close > b.open && Math.max(m.open, m.close) <= a.close * 1.002 && b.close > mid) {
            const entry = b.close, stop = Math.min(a.low, m.low, b.low);
            trades.push({ index: i, side: 'long', text: '샛별형', entry: entry, target: entry + rr * (entry - stop), stop: stop, from: i - 2, horizon: horizon });
          } else if (a.close > a.open && b.close < b.open && Math.min(m.open, m.close) >= a.close * 0.998 && b.close < mid) {
            const entry = b.close, stop = Math.max(a.high, m.high, b.high);
            trades.push({ index: i, side: 'short', text: '저녁별형', entry: entry, target: entry - rr * (stop - entry), stop: stop, from: i - 2, horizon: horizon });
          }
        }
        return assembleTrades(bars, trades, '#a3e635');
      }
    },
    {
      id: 'pat_cup', group: 'pattern', name: '컵앤핸들',
      desc: '둥근 바닥(컵) 뒤 얕은 되돌림(손잡이), 그리고 컵 가장자리 돌파. 목표 = 돌파가 + 컵 깊이, 손절 = 손잡이 저점.',
      params: [
        { key: 'minLen', label: '컵 최소', default: 20, min: 6, max: 300 },
        { key: 'maxLen', label: '컵 최대', default: 120, min: 10, max: 600 },
        { key: 'depth', label: '깊이 %', default: 12, min: 3, max: 60 },
        { key: 'horizon', label: '보유 봉수', default: 60, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const minLen = num(p, 'minLen', 20), maxLen = Math.max(num(p, 'maxLen', 120), minLen + 5);
        const minDepth = num(p, 'depth', 12) / 100, horizon = num(p, 'horizon', 60);
        const sw = swings(bars, 3);
        const highs = pluck(bars, 'high'), lows = pluck(bars, 'low');
        const trades = [], used = new Set();
        for (let li = 0; li < sw.highs.length; li++) {
          const L = sw.highs[li];
          for (let ri = li + 1; ri < sw.highs.length; ri++) {
            const R = sw.highs[ri];
            const span = R - L;
            if (span < minLen) continue;
            if (span > maxLen) break;
            const rim = Math.max(highs[L], highs[R]);
            if (Math.abs(highs[L] - highs[R]) / rim > 0.06) continue;
            // 두 가장자리 사이는 가장자리를 넘지 말아야 컵이다
            let bottom = Infinity, bIdx = -1, broken = false;
            for (let k = L + 1; k < R; k++) {
              if (highs[k] > rim * 1.01) { broken = true; break; }
              if (lows[k] < bottom) { bottom = lows[k]; bIdx = k; }
            }
            if (broken) continue;
            const depth = (rim - bottom) / rim;
            if (depth < minDepth || depth > 0.6) continue;
            const pos = (bIdx - L) / span;
            if (pos < 0.25 || pos > 0.75) continue;           // V 자가 아니라 둥근 바닥
            // 손잡이: R 뒤 5~40봉 안에서 컵 위쪽 절반에 머물다가 가장자리 돌파
            let handleLow = Infinity, hIdx = -1, breakout = -1;
            for (let k = R + 1; k < Math.min(bars.length, R + 41); k++) {
              if (bars[k].close > rim && k - R >= 3) { breakout = k; break; }
              if (lows[k] < handleLow) { handleLow = lows[k]; hIdx = k; }
              if (lows[k] < bottom + (rim - bottom) * 0.5) break;   // 너무 깊이 내려가면 손잡이가 아니다
            }
            if (breakout < 0 || hIdx < 0 || used.has(breakout)) continue;
            used.add(breakout);
            const entry = bars[breakout].close;
            trades.push({
              index: breakout, side: 'long', text: '컵앤핸들 돌파', entry: entry, target: entry + (rim - bottom), stop: handleLow, from: L, horizon: horizon,
              path: [{ index: L, price: highs[L] }, { index: bIdx, price: bottom }, { index: R, price: highs[R] }, { index: hIdx, price: handleLow }, { index: breakout, price: entry }],
              level: { from: L, to: breakout, price: rim, label: '컵 가장자리' }
            });
            break;
          }
        }
        return assembleTrades(bars, trades, '#2dd4bf');
      }
    },
    {
      id: 'pat_double', group: 'pattern', name: '쌍바닥 · 쌍봉',
      desc: '비슷한 높이의 바닥(꼭대기) 둘과 그 사이 반등. 사이 고점(저점)을 뚫으면 진입. 목표 = 패턴 높이만큼.',
      params: [
        { key: 'n', label: '스윙 봉수', default: 5, min: 2, max: 30 },
        { key: 'tol', label: '허용 %', default: 3, min: 0.5, max: 15, step: 0.5 },
        { key: 'horizon', label: '보유 봉수', default: 60, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const n = num(p, 'n', 5), tol = num(p, 'tol', 3) / 100, horizon = num(p, 'horizon', 60);
        const sw = swings(bars, n);
        const highs = pluck(bars, 'high'), lows = pluck(bars, 'low');
        const trades = [], used = new Set();
        // 쌍바닥
        for (let a = 0; a < sw.lows.length - 1; a++) {
          const i1 = sw.lows[a], i2 = sw.lows[a + 1];
          if (i2 - i1 < n * 2 || i2 - i1 > 120) continue;
          if (Math.abs(lows[i1] - lows[i2]) / lows[i1] > tol) continue;
          let neck = -Infinity, nIdx = -1;
          for (let k = i1 + 1; k < i2; k++) if (highs[k] > neck) { neck = highs[k]; nIdx = k; }
          const base = Math.min(lows[i1], lows[i2]);
          if ((neck - base) / base < 0.03) continue;
          for (let k = i2 + 1; k < Math.min(bars.length, i2 + 60); k++) {
            if (lows[k] < base * (1 - tol)) break;
            if (bars[k].close > neck) {
              if (used.has(k)) break;
              used.add(k);
              const entry = bars[k].close;
              trades.push({ index: k, side: 'long', text: '쌍바닥 돌파', entry: entry, target: entry + (neck - base), stop: lows[i2], from: i1, horizon: horizon,
                path: [{ index: i1, price: lows[i1] }, { index: nIdx, price: neck }, { index: i2, price: lows[i2] }, { index: k, price: entry }],
                level: { from: i1, to: k, price: neck, label: '목선' } });
              break;
            }
          }
        }
        // 쌍봉
        for (let a = 0; a < sw.highs.length - 1; a++) {
          const i1 = sw.highs[a], i2 = sw.highs[a + 1];
          if (i2 - i1 < n * 2 || i2 - i1 > 120) continue;
          if (Math.abs(highs[i1] - highs[i2]) / highs[i1] > tol) continue;
          let neck = Infinity, nIdx = -1;
          for (let k = i1 + 1; k < i2; k++) if (lows[k] < neck) { neck = lows[k]; nIdx = k; }
          const top = Math.max(highs[i1], highs[i2]);
          if ((top - neck) / top < 0.03) continue;
          for (let k = i2 + 1; k < Math.min(bars.length, i2 + 60); k++) {
            if (highs[k] > top * (1 + tol)) break;
            if (bars[k].close < neck) {
              if (used.has(k)) break;
              used.add(k);
              const entry = bars[k].close;
              trades.push({ index: k, side: 'short', text: '쌍봉 이탈', entry: entry, target: entry - (top - neck), stop: highs[i2], from: i1, horizon: horizon,
                path: [{ index: i1, price: highs[i1] }, { index: nIdx, price: neck }, { index: i2, price: highs[i2] }, { index: k, price: entry }],
                level: { from: i1, to: k, price: neck, label: '목선' } });
              break;
            }
          }
        }
        return assembleTrades(bars, trades, '#38bdf8');
      }
    },
    {
      id: 'pat_hs', group: 'pattern', name: '헤드앤숄더 (정·역)',
      desc: '어깨-머리-어깨 세 봉우리와 목선. 목선을 뚫으면 진입, 목표 = 머리 높이만큼, 손절 = 오른쪽 어깨.',
      params: [
        { key: 'n', label: '스윙 봉수', default: 5, min: 2, max: 30 },
        { key: 'tol', label: '어깨 허용 %', default: 5, min: 0.5, max: 20, step: 0.5 },
        { key: 'horizon', label: '보유 봉수', default: 60, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const n = num(p, 'n', 5), tol = num(p, 'tol', 5) / 100, horizon = num(p, 'horizon', 60);
        const sw = swings(bars, n);
        const highs = pluck(bars, 'high'), lows = pluck(bars, 'low');
        const trades = [], used = new Set();
        const extreme = (arr, from, to, isMin) => {
          let v = isMin ? Infinity : -Infinity, idx = -1;
          for (let k = from + 1; k < to; k++) if (isMin ? arr[k] < v : arr[k] > v) { v = arr[k]; idx = k; }
          return { v: v, idx: idx };
        };
        const scan = (peaks, isTop) => {
          const P = isTop ? highs : lows, O = isTop ? lows : highs;
          for (let a = 0; a + 2 < peaks.length; a++) {
            const s1 = peaks[a], h = peaks[a + 1], s2 = peaks[a + 2];
            if (s2 - s1 > 160) continue;
            const higher = (x, y) => (isTop ? P[x] > P[y] : P[x] < P[y]);
            if (!higher(h, s1) || !higher(h, s2)) continue;
            if (Math.abs(P[h] - P[s1]) / P[h] < 0.02 || Math.abs(P[h] - P[s2]) / P[h] < 0.02) continue;
            if (Math.abs(P[s1] - P[s2]) / P[s1] > tol) continue;
            const n1 = extreme(O, s1, h, isTop), n2 = extreme(O, h, s2, isTop);
            if (n1.idx < 0 || n2.idx < 0) continue;
            const slope = (n2.v - n1.v) / (n2.idx - n1.idx);
            const neckAt = (k) => n1.v + slope * (k - n1.idx);
            for (let k = s2 + 1; k < Math.min(bars.length, s2 + 60); k++) {
              if (isTop ? highs[k] > P[h] : lows[k] < P[h]) break;
              const nk = neckAt(k);
              if (isTop ? bars[k].close < nk : bars[k].close > nk) {
                if (used.has(k)) break;
                used.add(k);
                const entry = bars[k].close, headH = Math.abs(P[h] - neckAt(h));
                trades.push({
                  index: k, side: isTop ? 'short' : 'long', text: isTop ? '헤드앤숄더 목선 이탈' : '역헤드앤숄더 목선 돌파', entry: entry,
                  target: isTop ? entry - headH : entry + headH, stop: P[s2], from: s1, horizon: horizon,
                  path: [{ index: s1, price: P[s1] }, { index: n1.idx, price: n1.v }, { index: h, price: P[h] }, { index: n2.idx, price: n2.v }, { index: s2, price: P[s2] }, { index: k, price: entry }],
                  segment: { points: [{ index: n1.idx, price: n1.v }, { index: k, price: nk }], label: '목선' }
                });
                break;
              }
            }
          }
        };
        scan(sw.highs, true); scan(sw.lows, false);
        return assembleTrades(bars, trades, '#fb7185');
      }
    },
    {
      id: 'strat_bb', group: 'pattern', name: '볼린저 밴드 매매',
      desc: '되돌림: 하단 밴드 밖에서 안으로 들어오면 매수, 목표 = 중심선. 돌파: 밴드가 좁아진 뒤 상단을 뚫으면 매수, 손절 = 중심선.',
      params: [
        { key: 'mode', label: '방식', default: 'revert', type: 'select', options: [['revert', '되돌림'], ['breakout', '스퀴즈 돌파']] },
        { key: 'period', label: '기간', default: 20, min: 2, max: 400 },
        { key: 'mult', label: '배수', default: 2, min: 0.5, max: 5, step: 0.1 },
        { key: 'horizon', label: '보유 봉수', default: 30, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const mode = p && p.mode === 'breakout' ? 'breakout' : 'revert';
        const period = num(p, 'period', 20), mult = num(p, 'mult', 2), horizon = num(p, 'horizon', 30);
        const closes = pluck(bars, 'close');
        const bb = bollinger(closes, period, mult);
        const trades = [];
        if (mode === 'revert') {
          let belowFrom = -1, aboveFrom = -1;
          for (let i = 1; i < bars.length; i++) {
            if (bb.lower[i] == null || bb.lower[i - 1] == null) continue;
            const c = closes[i];
            if (c < bb.lower[i]) { if (belowFrom < 0) belowFrom = i; }
            else if (belowFrom >= 0) {
              let stop = Infinity; for (let k = belowFrom; k <= i; k++) stop = Math.min(stop, bars[k].low);
              trades.push({ index: i, side: 'long', text: '볼린저 하단 되돌림', entry: c, target: bb.middle[i], stop: stop, from: belowFrom, horizon: horizon });
              belowFrom = -1;
            }
            if (c > bb.upper[i]) { if (aboveFrom < 0) aboveFrom = i; }
            else if (aboveFrom >= 0) {
              let stop = -Infinity; for (let k = aboveFrom; k <= i; k++) stop = Math.max(stop, bars[k].high);
              trades.push({ index: i, side: 'short', text: '볼린저 상단 되돌림', entry: c, target: bb.middle[i], stop: stop, from: aboveFrom, horizon: horizon });
              aboveFrom = -1;
            }
          }
        } else {
          const width = bb.upper.map((u, i) => (u == null || !bb.middle[i] ? null : (u - bb.lower[i]) / bb.middle[i]));
          const look = Math.max(period * 4, 60);
          const minW = lowest(width.map((w) => (w == null ? Infinity : w)), look);
          let squeezeUntil = -1;
          for (let i = 1; i < bars.length; i++) {
            if (width[i] == null || minW[i] == null || !isFinite(minW[i])) continue;
            if (width[i] <= minW[i] * 1.15) squeezeUntil = i + 5;       // 최근 5봉 안에 스퀴즈가 있었다
            if (i > squeezeUntil) continue;
            const c = closes[i];
            if (c > bb.upper[i] && closes[i - 1] <= bb.upper[i - 1]) {
              const stop = bb.middle[i];
              trades.push({ index: i, side: 'long', text: '볼린저 스퀴즈 상향 돌파', entry: c, target: c + 2 * (c - stop), stop: stop, from: Math.max(0, i - 5), horizon: horizon });
              squeezeUntil = -1;
            } else if (c < bb.lower[i] && closes[i - 1] >= bb.lower[i - 1]) {
              const stop = bb.middle[i];
              trades.push({ index: i, side: 'short', text: '볼린저 스퀴즈 하향 돌파', entry: c, target: c - 2 * (stop - c), stop: stop, from: Math.max(0, i - 5), horizon: horizon });
              squeezeUntil = -1;
            }
          }
        }
        const r = assembleTrades(bars, trades, '#38bdf8');
        r.overlays.unshift({ kind: 'band', name: '볼린저', upper: bb.upper, lower: bb.lower, middle: bb.middle, color: '#38bdf8' });
        return r;
      }
    },
    {
      id: 'strat_box', group: 'pattern', name: '박스권 돌파',
      desc: 'n일 동안 좁은 범위에 갇혀 있다가 위(아래)로 벗어나면 진입. 목표 = 박스 높이만큼, 손절 = 박스 가운데.',
      params: [
        { key: 'n', label: '박스 봉수', default: 20, min: 5, max: 300 },
        { key: 'width', label: '최대 폭 %', default: 10, min: 1, max: 60 },
        { key: 'horizon', label: '보유 봉수', default: 40, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const n = num(p, 'n', 20), maxW = num(p, 'width', 10) / 100, horizon = num(p, 'horizon', 40);
        const hh = highest(pluck(bars, 'high'), n), ll = lowest(pluck(bars, 'low'), n);
        const trades = [];
        let cooldown = -1;
        for (let i = n; i < bars.length; i++) {
          const H = hh[i - 1], L = ll[i - 1];           // 오늘을 뺀 직전 n 봉의 박스
          if (H == null || i <= cooldown) continue;
          if ((H - L) / L > maxW) continue;
          const c = bars[i].close;
          if (c > H) {
            trades.push({ index: i, side: 'long', text: '박스 상향 돌파', entry: c, target: c + (H - L), stop: (H + L) / 2, from: i - n, horizon: horizon,
              level: { from: i - n, to: i, price: H, label: '박스 상단' }, level2: { from: i - n, to: i, price: L, label: '박스 하단' } });
            cooldown = i + n;
          } else if (c < L) {
            trades.push({ index: i, side: 'short', text: '박스 하향 이탈', entry: c, target: c - (H - L), stop: (H + L) / 2, from: i - n, horizon: horizon,
              level: { from: i - n, to: i, price: H, label: '박스 상단' }, level2: { from: i - n, to: i, price: L, label: '박스 하단' } });
            cooldown = i + n;
          }
        }
        return assembleTrades(bars, trades, '#ffb347');
      }
    },
    {
      id: 'strat_pullback', group: 'pattern', name: '이동평균 눌림목',
      desc: '장기선 위 상승 추세에서 단기선까지 눌렸다가 양봉으로 받치면 매수. 손절 = 단기선 아래, 목표 = 손절폭 × 배수.',
      params: [
        { key: 'fast', label: '단기', default: 20, min: 2, max: 200 },
        { key: 'slow', label: '장기', default: 60, min: 5, max: 400 },
        { key: 'rr', label: '손익비', default: 2, min: 0.5, max: 10, step: 0.5 },
        { key: 'horizon', label: '보유 봉수', default: 30, min: 3, max: 400 }
      ],
      compute(bars, p) {
        const fast = num(p, 'fast', 20), slow = num(p, 'slow', 60), rr = num(p, 'rr', 2), horizon = num(p, 'horizon', 30);
        const closes = pluck(bars, 'close');
        const f = sma(closes, fast), s = sma(closes, slow);
        const trades = [];
        let cooldown = -1;
        for (let i = 5; i < bars.length; i++) {
          if (f[i] == null || s[i] == null || f[i - 3] == null || i <= cooldown) continue;
          const b = bars[i];
          const trendUp = closes[i] > s[i] && f[i] > s[i] && f[i] > f[i - 3];
          if (!trendUp) continue;
          let cameFromAbove = false;
          for (let k = i - 5; k < i; k++) if (closes[k] > f[k] * 1.02) cameFromAbove = true;
          if (!cameFromAbove) continue;
          if (b.low <= f[i] * 1.01 && b.close > f[i] && b.close > b.open) {
            const entry = b.close, stop = Math.min(b.low, f[i] * 0.98);
            trades.push({ index: i, side: 'long', text: '눌림목 매수 (MA' + fast + ')', entry: entry, target: entry + rr * (entry - stop), stop: stop, from: i - 3, horizon: horizon });
            cooldown = i + 3;
          }
        }
        const r = assembleTrades(bars, trades, '#a3e635');
        r.overlays.unshift({ kind: 'line', name: 'MA ' + fast, color: 'rgba(163,230,53,0.7)', values: f, width: 1 },
                           { kind: 'line', name: 'MA ' + slow, color: 'rgba(124,92,255,0.7)', values: s, width: 1 });
        return r;
      }
    },

    // ── 매매 신호 (차트 위 표시 + 아래 목록) ──
    {
      id: 'sig_macross', group: 'signal', name: '골든·데드 크로스',
      desc: '단기 이동평균이 장기선을 위로 뚫으면 골든(매수), 아래로 뚫으면 데드(매도).',
      params: [
        { key: 'fast', label: '단기', default: 5, min: 1, max: 200 },
        { key: 'slow', label: '장기', default: 20, min: 2, max: 400 }
      ],
      compute(bars, p) {
        const closes = pluck(bars, 'close');
        const f = sma(closes, num(p, 'fast', 5)), s = sma(closes, num(p, 'slow', 20));
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          const c = crossAt(f, s, i);
          if (c > 0) markers.push({ index: i, type: 'buy', text: '골든크로스 ' + num(p, 'fast', 5) + '/' + num(p, 'slow', 20), price: bars[i].close });
          else if (c < 0) markers.push({ index: i, type: 'sell', text: '데드크로스 ' + num(p, 'fast', 5) + '/' + num(p, 'slow', 20), price: bars[i].close });
        }
        return {
          overlays: [
            { kind: 'line', name: 'MA ' + num(p, 'fast', 5), color: 'rgba(255,179,71,0.6)', values: f, width: 1 },
            { kind: 'line', name: 'MA ' + num(p, 'slow', 20), color: 'rgba(124,92,255,0.6)', values: s, width: 1 }
          ],
          markers: markers
        };
      }
    },
    {
      id: 'sig_macd', group: 'signal', name: 'MACD 크로스',
      desc: 'MACD 선이 시그널선을 위로 뚫으면 매수, 아래로 뚫으면 매도.',
      params: [
        { key: 'fast', label: '빠름', default: 12, min: 2, max: 200 },
        { key: 'slow', label: '느림', default: 26, min: 3, max: 400 },
        { key: 'signal', label: '시그널', default: 9, min: 2, max: 100 }
      ],
      compute(bars, p) {
        const r = macd(pluck(bars, 'close'), num(p, 'fast', 12), num(p, 'slow', 26), num(p, 'signal', 9));
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          const c = crossAt(r.macd, r.signal, i);
          if (c > 0) markers.push({ index: i, type: 'buy', text: 'MACD 골든크로스', price: bars[i].close });
          else if (c < 0) markers.push({ index: i, type: 'sell', text: 'MACD 데드크로스', price: bars[i].close });
        }
        return { markers: markers };
      }
    },
    {
      id: 'sig_rsi', group: 'signal', name: 'RSI 과매수·과매도 탈출',
      desc: '과매도 구간에서 올라오면 매수, 과매수 구간에서 내려오면 매도.',
      params: [
        { key: 'period', label: '기간', default: 14, min: 2, max: 200 },
        { key: 'hi', label: '과매수', default: 70, min: 50, max: 99 },
        { key: 'lo', label: '과매도', default: 30, min: 1, max: 50 }
      ],
      compute(bars, p) {
        const r = rsi(pluck(bars, 'close'), num(p, 'period', 14));
        const hi = num(p, 'hi', 70), lo = num(p, 'lo', 30);
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          if (r[i] == null || r[i - 1] == null) continue;
          if (r[i - 1] < lo && r[i] >= lo) markers.push({ index: i, type: 'buy', text: 'RSI 과매도 탈출 (' + r[i].toFixed(0) + ')', price: bars[i].close });
          else if (r[i - 1] > hi && r[i] <= hi) markers.push({ index: i, type: 'sell', text: 'RSI 과매수 탈출 (' + r[i].toFixed(0) + ')', price: bars[i].close });
        }
        return { markers: markers };
      }
    },
    {
      id: 'sig_bb', group: 'signal', name: '볼린저 밴드 이탈',
      desc: '종가가 하단 밴드 아래로 내려가면 매수 후보, 상단 위로 올라가면 매도 후보.',
      params: [
        { key: 'period', label: '기간', default: 20, min: 2, max: 400 },
        { key: 'mult', label: '배수', default: 2, min: 0.5, max: 5, step: 0.1 }
      ],
      compute(bars, p) {
        const bb = bollinger(pluck(bars, 'close'), num(p, 'period', 20), num(p, 'mult', 2));
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          if (bb.upper[i] == null || bb.upper[i - 1] == null) continue;
          const c = bars[i].close, pc = bars[i - 1].close;
          if (c < bb.lower[i] && pc >= bb.lower[i - 1]) markers.push({ index: i, type: 'buy', text: '볼린저 하단 이탈', price: c });
          else if (c > bb.upper[i] && pc <= bb.upper[i - 1]) markers.push({ index: i, type: 'sell', text: '볼린저 상단 이탈', price: c });
        }
        return { markers: markers };
      }
    },
    {
      id: 'sig_stoch', group: 'signal', name: '스토캐스틱 크로스',
      desc: '과매도(20 아래)에서 %K 가 %D 를 위로 뚫으면 매수, 과매수(80 위)에서 아래로 뚫으면 매도.',
      params: [
        { key: 'k', label: '%K', default: 14, min: 2, max: 200 },
        { key: 'ks', label: '%K 평활', default: 3, min: 1, max: 50 },
        { key: 'd', label: '%D', default: 3, min: 1, max: 50 }
      ],
      compute(bars, p) {
        const r = stochastic(bars, num(p, 'k', 14), num(p, 'ks', 3), num(p, 'd', 3));
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          const c = crossAt(r.k, r.d, i);
          if (c > 0 && r.d[i] < 25) markers.push({ index: i, type: 'buy', text: '스토캐스틱 골든크로스', price: bars[i].close });
          else if (c < 0 && r.d[i] > 75) markers.push({ index: i, type: 'sell', text: '스토캐스틱 데드크로스', price: bars[i].close });
        }
        return { markers: markers };
      }
    },
    {
      id: 'sig_volume', group: 'signal', name: '거래량 급증',
      desc: '거래량이 평균의 n배를 넘는 날. 오른 날이면 매수세, 내린 날이면 매도세 유입.',
      params: [
        { key: 'ma', label: '평균', default: 20, min: 1, max: 400 },
        { key: 'mult', label: '배수', default: 2.5, min: 1.1, max: 20, step: 0.1 }
      ],
      compute(bars, p) {
        const m = sma(pluck(bars, 'volume'), num(p, 'ma', 20));
        const k = num(p, 'mult', 2.5);
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          if (m[i - 1] == null || m[i - 1] === 0) continue;
          if (bars[i].volume > m[i - 1] * k) {
            const up = bars[i].close >= bars[i].open;
            markers.push({ index: i, type: 'note', text: '거래량 급증 ×' + (bars[i].volume / m[i - 1]).toFixed(1) + (up ? ' (양봉)' : ' (음봉)'), price: bars[i].close, place: up ? 'below' : 'above', color: up ? '#ff5470' : '#4c8dff' });
          }
        }
        return { markers: markers };
      }
    },
    {
      id: 'sig_gap', group: 'signal', name: '갭 상승·하락',
      desc: '시가가 전날 고가보다 n% 위(갭 상승)거나 전날 저가보다 n% 아래(갭 하락)인 날.',
      params: [{ key: 'pct', label: '기준 %', default: 2, min: 0.1, max: 50, step: 0.5 }],
      compute(bars, p) {
        const k = num(p, 'pct', 2) / 100;
        const markers = [];
        for (let i = 1; i < bars.length; i++) {
          const prev = bars[i - 1];
          if (bars[i].open > prev.high * (1 + k)) markers.push({ index: i, type: 'note', text: '갭 상승 ' + (((bars[i].open / prev.close) - 1) * 100).toFixed(1) + '%', price: bars[i].open, place: 'below', color: '#ff5470' });
          else if (bars[i].open < prev.low * (1 - k)) markers.push({ index: i, type: 'note', text: '갭 하락 ' + (((bars[i].open / prev.close) - 1) * 100).toFixed(1) + '%', price: bars[i].open, place: 'above', color: '#4c8dff' });
        }
        return { markers: markers };
      }
    }
  ];

  const GROUPS = [
    { id: 'pattern', name: '패턴 · 매매 전략 (진입 → 목표 · 손절)', hint: '패턴이 완성된 봉에 ▲▼ 진입 표시, 그 뒤로 목표가·손절가 선을 긋고 실제로 어디에 먼저 닿았는지(★ 목표 도달 / ✕ 손절)까지 표시합니다.' },
    { id: 'trend', name: '추세 · 차트 위에 겹침', hint: '체크하면 가격 차트 위에 선·밴드로 그려집니다.' },
    { id: 'momentum', name: '모멘텀 · 거래량 (아래 패널)', hint: '체크하면 차트 아래에 패널이 하나씩 붙습니다.' },
    { id: 'signal', name: '매매 신호', hint: '조건에 맞는 날에 ▲▼ 표시가 붙고 아래 목록에 정리됩니다.' }
  ];

  function techniqueById(id) {
    return TECHNIQUES.find((t) => t.id === id) || null;
  }

  // 파라미터 입력값 정리: 빠졌거나 잘못된 값은 기본값으로.
  function normalizeParams(tech, raw) {
    const out = {};
    (tech.params || []).forEach((def) => {
      const v = raw && raw[def.key];
      if (def.type === 'list') out[def.key] = v == null || String(v).trim() === '' ? String(def.default) : String(v);
      else if (def.type === 'select') out[def.key] = def.options.some((o) => o[0] === v) ? v : def.default;
      else {
        let n = v == null || String(v).trim() === '' ? def.default : Number(v);
        if (!isFinite(n)) n = def.default;
        if (def.min != null && n < def.min) n = def.min;
        if (def.max != null && n > def.max) n = def.max;
        out[def.key] = n;
      }
    });
    return out;
  }

  // 체크된 기법을 전부 계산해서 차트가 그릴 묶음으로.
  //   selection: [{id, params}] 또는 ['sma', 'rsi', ...]
  function buildStudy(bars, selection) {
    const study = { overlays: [], panels: [], markers: [], errors: [], extra: 0 };
    (selection || []).forEach((sel) => {
      const id = typeof sel === 'string' ? sel : sel.id;
      const tech = techniqueById(id);
      if (!tech) return;
      const params = normalizeParams(tech, typeof sel === 'string' ? null : sel.params);
      let r;
      try { r = tech.compute(bars, params) || {}; }
      catch (e) { study.errors.push({ id: id, message: e.message }); return; }
      (r.overlays || []).forEach((o) => {
        o.techId = id;
        study.overlays.push(o);
        const lens = ['values', 'upper', 'lower', 'a', 'b'].map((k) => (o[k] ? o[k].length : 0));
        study.extra = Math.max(study.extra, Math.max.apply(null, lens) - bars.length);
      });
      if (r.panel) { r.panel.techId = id; r.panel.id = id; study.panels.push(r.panel); }
      (r.markers || []).forEach((m) => { m.techId = id; m.techName = tech.name; m.date = bars[m.index] && bars[m.index].date; study.markers.push(m); });
    });
    study.markers.sort((a, b) => a.index - b.index);
    return study;
  }

  // 화면 상단 요약: 마지막 봉, 전일 대비, 기간 고저.
  function summarize(bars) {
    if (!bars || !bars.length) return null;
    const last = bars[bars.length - 1], prev = bars.length > 1 ? bars[bars.length - 2] : null;
    let hi = -Infinity, lo = Infinity;
    bars.forEach((b) => { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; });
    return {
      count: bars.length, from: bars[0].date, to: last.date,
      close: last.close, change: prev ? last.close - prev.close : 0,
      changePct: prev && prev.close ? ((last.close / prev.close) - 1) * 100 : 0,
      high: hi, low: lo
    };
  }

  return {
    parseCsv, parseJson, parseAny, toDateKey, toNumber, matchHeader,
    generateSample, ind, TECHNIQUES, GROUPS, techniqueById, normalizeParams, buildStudy, summarize, PALETTE,
    simulateTrade, assembleTrades, OUTCOME_TEXT
  };
}));
