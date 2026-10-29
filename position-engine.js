/* 포지션 사이징 + 1:2:6 분할매매 백테스트 엔진.
 *
 * 브라우저(<script src="/position-engine.js">)와 Node(require) 양쪽에서 같은 코드를
 * 씁니다. 계산기 화면, 백테스트 화면, tools/backtest-btc.js, 테스트가 전부 이 파일
 * 하나를 봅니다.
 *
 * 구성
 *   1. 지표      rsi(와일더), ema, macd(12/26/9), ichimoku(9/26/52, 선행스팬 26 이동)
 *   2. 사이징    sizePosition — "내가 틀리면 얼마 잃나"를 먼저 정하고 매수 금액을 거꾸로 계산
 *                (현물·선물, 롱·숏, 분할 가중치, 청산가 포함)
 *   3. 백테스트  backtest — 캔들 배열 하나로 1:2:6 / 한 번에 진입 / 물타기를 같은 규칙으로 비교
 *
 * 이 파일은 투자 판단을 내려 주지 않습니다. 규칙을 숫자로 못 박고 과거 데이터에
 * 돌려 보는 도구일 뿐이며, 과거 성과는 앞으로를 보장하지 않습니다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PositionEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NAN = NaN;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function fill(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = NAN; return a; }

  // ── 1. 지표 ────────────────────────────────────────────────────────────
  /** 와일더 RSI. 앞의 n개는 NaN. */
  function rsi(close, n) {
    n = n || 14;
    var out = fill(close.length);
    if (close.length <= n) return out;
    var g = 0, l = 0, i;
    for (i = 1; i <= n; i++) { var d = close[i] - close[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    out[n] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    for (i = n + 1; i < close.length; i++) {
      var dd = close[i] - close[i - 1];
      g = (g * (n - 1) + (dd > 0 ? dd : 0)) / n;
      l = (l * (n - 1) + (dd < 0 ? -dd : 0)) / n;
      out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  /** EMA. 앞쪽 NaN 은 건너뛰고, 처음 n개 값의 단순평균을 씨앗으로 씁니다. */
  function ema(arr, n) {
    var out = fill(arr.length), start = 0;
    while (start < arr.length && !isNum(arr[start])) start++;
    if (arr.length - start < n) return out;
    var sum = 0, i;
    for (i = start; i < start + n; i++) sum += arr[i];
    var prev = sum / n, k = 2 / (n + 1);
    out[start + n - 1] = prev;
    for (i = start + n; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  function sma(arr, n) {
    var out = fill(arr.length), sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i]; if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /** ATR(와일더). 첫 값은 처음 n칸 True Range 의 평균. */
  function atr(high, low, close, n) {
    n = n || 14;
    var out = fill(close.length), tr = [], i;
    for (i = 0; i < close.length; i++) tr.push(i === 0 ? high[0] - low[0] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    if (close.length < n) return out;
    var a = 0; for (i = 0; i < n; i++) a += tr[i]; a /= n; out[n - 1] = a;
    for (i = n; i < close.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
    return out;
  }

  function macd(close, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    var f = ema(close, fast), s = ema(close, slow), line = fill(close.length);
    for (var i = 0; i < close.length; i++) if (isNum(f[i]) && isNum(s[i])) line[i] = f[i] - s[i];
    var signal = ema(line, sig), hist = fill(close.length);
    for (var j = 0; j < close.length; j++) if (isNum(line[j]) && isNum(signal[j])) hist[j] = line[j] - signal[j];
    return { macd: line, signal: signal, hist: hist };
  }

  function rollMid(high, low, n) {
    var out = fill(high.length);
    for (var i = n - 1; i < high.length; i++) {
      var h = -Infinity, l = Infinity;
      for (var j = i - n + 1; j <= i; j++) { if (high[j] > h) h = high[j]; if (low[j] < l) l = low[j]; }
      out[i] = (h + l) / 2;
    }
    return out;
  }

  /** 일목균형표. 구름(선행스팬 A/B)은 26칸 앞에 그려지므로, 인덱스 i 의 구름은
   *  i-26 시점까지의 데이터로 만든 값입니다(미래 데이터를 쓰지 않음). */
  function ichimoku(high, low, tenkanN, kijunN, spanBN, shift) {
    tenkanN = tenkanN || 9; kijunN = kijunN || 26; spanBN = spanBN || 52; shift = shift || 26;
    var t = rollMid(high, low, tenkanN), k = rollMid(high, low, kijunN), b = rollMid(high, low, spanBN);
    var n = high.length, a = fill(n), bb = fill(n), top = fill(n), bot = fill(n);
    for (var i = shift; i < n; i++) {
      var p = i - shift;
      if (isNum(t[p]) && isNum(k[p])) a[i] = (t[p] + k[p]) / 2;
      if (isNum(b[p])) bb[i] = b[p];
      if (isNum(a[i]) && isNum(bb[i])) { top[i] = Math.max(a[i], bb[i]); bot[i] = Math.min(a[i], bb[i]); }
    }
    return { tenkan: t, kijun: k, spanA: a, spanB: bb, top: top, bottom: bot };
  }

  // ── 2. 사이징 ──────────────────────────────────────────────────────────
  var DEFAULT_WEIGHTS = [1, 2, 6];

  /** 한 번의 거래에서 감수할 손실(riskPct)을 먼저 정하고, 그 안에서 매수 금액을 정한다.
   *
   *   입력(전부 숫자)
   *     account   계좌 금액
   *     riskPct   최대 손실 % (계좌 대비)
   *     entry     첫 진입가
   *     stop      손절가
   *     side      'long' | 'short' (short 는 선물만)
   *     leverage  1 = 현물. 선물은 1 초과도 가능
   *     feePct    한 번 거래당 수수료 %, slipPct 슬리피지 %
   *     mmrPct    유지증거금률 % (청산가 근사에 씀)
   *     weights   분할 가중치 (기본 1:2:6)
   *     stagePrices  각 단계를 실제로 살 것으로 예상하는 가격(없으면 전부 entry)
   *   손실은 "모든 단계가 체결된 뒤 손절가에서 청산"을 기준으로 맞춥니다.
   *   그래서 뒤 단계를 더 비싸게 사면 전체 매수 금액이 자동으로 줄어듭니다. */
  function sizePosition(p) {
    var warnings = [];
    var side = p.side === 'short' ? 'short' : 'long';
    var d = side === 'long' ? 1 : -1;
    var lev = isNum(p.leverage) && p.leverage > 0 ? p.leverage : 1;
    var w = (p.weights && p.weights.length ? p.weights : DEFAULT_WEIGHTS).slice();
    var account = +p.account, riskPct = +p.riskPct, entry = +p.entry, stop = +p.stop;
    var fee = ((+p.feePct || 0) + (+p.slipPct || 0)) / 100;       // 한 방향 비용 비율
    var mmr = (isNum(+p.mmrPct) ? +p.mmrPct : 0.5) / 100;
    var res = { ok: false, side: side, leverage: lev, warnings: warnings };
    if (!(account > 0) || !(riskPct > 0) || !(entry > 0) || !(stop > 0)) {
      warnings.push('계좌·최대손실·진입가·손절가를 모두 양수로 넣어 주세요.');
      return res;
    }
    if (side === 'short' && lev <= 1) warnings.push('숏은 선물에서만 할 수 있습니다. 레버리지를 1 초과로 두세요(현물은 불가).');
    var sp = (p.stagePrices && p.stagePrices.length === w.length ? p.stagePrices : w.map(function () { return entry; })).map(Number);
    var lossRate = [];                                              // 단계별 "손절까지 1원당 손실"
    for (var i = 0; i < w.length; i++) {
      var r = d * (sp[i] - stop) / sp[i];
      if (!(r > 0)) {
        warnings.push((i + 1) + '단계 가격(' + sp[i] + ')이 손절가(' + stop + ') ' + (side === 'long' ? '아래' : '위') + '입니다. 손절가는 진입가보다 ' + (side === 'long' ? '낮게' : '높게') + ' 두세요.');
        return res;
      }
      lossRate.push(r + 2 * fee);                                  // 들어갈 때 + 나갈 때 비용
    }
    var riskAmount = account * riskPct / 100;
    var denom = 0, sumW = 0, j;
    for (j = 0; j < w.length; j++) { denom += w[j] * lossRate[j]; sumW += w[j]; }
    var k = riskAmount / denom;                                     // 가중치 1당 매수 금액
    var cap = account * lev;
    var capped = false;
    if (k * sumW > cap) { k = cap / sumW; capped = true; warnings.push('손실 한도로 계산한 금액이 계좌×레버리지(' + Math.round(cap) + ')를 넘어 그 한도로 줄였습니다. 손실은 한도보다 작아집니다.'); }
    var stages = [], totalN = 0, totalU = 0;
    for (j = 0; j < w.length; j++) {
      var n = k * w[j], u = n / sp[j];
      totalN += n; totalU += u;
      stages.push({ stage: j + 1, weight: w[j], price: sp[j], notional: n, units: u, margin: n / lev, share: w[j] / sumW });
    }
    var avg = totalN / totalU;
    var lossAtStop = 0;
    for (j = 0; j < stages.length; j++) lossAtStop += stages[j].notional * lossRate[j];
    var liq = lev > 1 ? (side === 'long' ? avg * (1 - 1 / lev + mmr) : avg * (1 + 1 / lev - mmr)) : null;
    var stopDistAvg = d * (avg - stop) / avg;
    var safeGap = 1.2;                                              // 청산가가 손절가보다 최소 20% 더 멀어야 안전하다고 본다
    var maxSafe = 1 / (stopDistAvg * safeGap + mmr);
    var liqFirst = false;
    if (liq !== null) {
      liqFirst = side === 'long' ? liq >= stop : liq <= stop;
      if (liqFirst) warnings.push('청산가가 손절가보다 가깝습니다. 손절이 나가기 전에 청산됩니다. 레버리지를 ' + maxSafe.toFixed(1) + '배 이하로 낮추세요.');
      else if (lev > maxSafe) warnings.push('청산가와 손절가 사이 여유가 20% 미만입니다(급변·갭 때 손절이 밀릴 수 있음). 권장 상한 ' + maxSafe.toFixed(1) + '배.');
    }
    if (lev > 1 && capped === false && totalN / account < 1) warnings.push('필요한 증거금은 계좌의 ' + (100 * totalN / lev / account).toFixed(1) + '% 뿐입니다. 레버리지를 올려도 손실 한도는 그대로이고 청산만 가까워집니다.');
    res.ok = true; res.riskAmount = riskAmount; res.stopDistPct = 100 * stopDistAvg; res.totalNotional = totalN;
    res.totalUnits = totalU; res.avgEntry = avg; res.margin = totalN / lev; res.marginPct = 100 * totalN / lev / account;
    res.notionalPct = 100 * totalN / account; res.stages = stages; res.lossAtStop = lossAtStop;
    res.lossAtStopPct = 100 * lossAtStop / account; res.liqPrice = liq; res.liqBeforeStop = liqFirst;
    res.maxSafeLeverage = maxSafe; res.capped = capped; res.feeRate = fee;
    return res;
  }

  // ── 3. 백테스트 ────────────────────────────────────────────────────────
  var DEFAULTS = {
    side: 'long',            // 'long' | 'short'(선물만 의미 있음)
    mode: 'ladder',          // 'ladder' 1:2:6 | 'allin' 첫 신호에 전부 | 'avgdown' 신호 없이 가격만 보고 물타기
    weights: [1, 2, 6],
    riskPct: 2,              // 거래당 최대 손실 % (계좌 대비)
    leverage: 1,             // 1 = 현물
    feePct: 0.05,            // 한 방향 수수료 %
    slipPct: 0.02,           // 한 방향 슬리피지 %
    fundingPer8hPct: 0,      // 펀딩비(8시간당 %). 롱이 내고 숏이 받는 부호
    barHours: 24,            // 캔들 한 칸의 시간
    mmrPct: 0.5,             // 유지증거금률 %
    startEquity: 10000,
    compound: true,          // true 면 거래마다 현재 자산 기준으로 위험을 계산
    rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, rsiExit: 50,
    swingLookback: 20,       // 손절가 = 최근 N칸 저점(숏은 고점)
    maxStopPct: 15, minStopPct: 1,
    stageWindow: 40,         // 1단계 뒤 MACD 확인까지 기다리는 칸 수
    cloudWindow: 30,         // 구름 돌파 뒤 되돌림 지지까지 기다리는 칸 수
    pullbackTolPct: 1.5,     // 구름 경계에서 이 % 안까지 내려오면 "받친다"고 봄
    // 노이즈 필터 — 0 이면 꺼짐(기본값은 필터 없음)
    trendMaPeriod: 0,        // N칸 이동평균으로 1단계 진입을 거름(0 = 끔)
    trendMode: 'above',      // 'above' 롱은 종가가 평균 위(숏은 아래) · 'slope' 평균선 자체가 10칸 전보다 오르는 중(숏은 내리는 중)
    cooldownBars: 0,         // 포지션을 닫은 뒤 N칸 동안 새 진입 금지(손절 직후 재진입 방지)
    atrStopMult: 0,          // >0 이면 손절가 = 진입가 ∓ ATR(14)×이 값 (0 이면 최근 저점/고점)
    avgDownStepPct: 5        // avgdown: 첫 진입가에서 이 % 씩 떨어질 때마다 추가
  };

  function merge(o) { var r = {}, k; for (k in DEFAULTS) r[k] = DEFAULTS[k]; if (o) for (k in o) if (o[k] !== undefined && o[k] !== null) r[k] = o[k]; return r; }

  /** candles: [{t, o, h, l, c}] 시간순. 신호는 칸이 닫힐 때 판정하고 그 종가(±슬리피지)에 체결합니다.
   *  손절은 다음 칸부터 고가/저가로 검사하고, 시가가 손절가를 넘어 갭이 나면 시가로 체결합니다. */
  function backtest(candles, opts) {
    var P = merge(opts);
    var d = P.side === 'short' ? -1 : 1;
    var n = candles.length;
    var res = { params: P, trades: [], equity: [], stats: null, warnings: [] };
    if (n < 120) { res.warnings.push('캔들이 120개 미만이라 지표가 자리 잡기 전에 끝납니다.'); }
    var O = [], H = [], L = [], C = [], T = [];
    for (var q = 0; q < n; q++) { O.push(candles[q].o); H.push(candles[q].h); L.push(candles[q].l); C.push(candles[q].c); T.push(candles[q].t); }
    var R = rsi(C, P.rsiPeriod), M = macd(C), I = ichimoku(H, L);
    var TR = P.trendMaPeriod > 0 ? sma(C, P.trendMaPeriod) : null;
    var AT = P.atrStopMult > 0 ? atr(H, L, C, 14) : null;
    var lastClose = -1e9;                                             // 마지막으로 포지션을 닫은 칸(쿨다운용)
    var fee = P.feePct / 100, slip = P.slipPct / 100, mmr = P.mmrPct / 100, lev = Math.max(1, P.leverage);
    var fund = d * P.fundingPer8hPct / 100 * (P.barHours / 8);
    var W = P.weights, sumW = 0; W.forEach(function (x) { sumW += x; });
    var warm = Math.max(52 + 26, P.trendMaPeriod + 10);                                               // 구름이 처음 생기는 칸
    var equity = P.startEquity, peak = equity, maxDD = 0;
    var pos = null, st = null, bhStart = null, exposure = 0, liqCount = 0;
    var stageReach = [0, 0, 0];
    var sizeEquity = function () { return P.compound ? equity : P.startEquity; };

    function buyPx(i) { return C[i] * (1 + d * slip); }               // 진입(롱은 비싸게, 숏은 싸게)
    function sellPx(price) { return price * (1 - d * slip); }         // 청산

    function riskAtStop(pp) {                                          // 현재 보유분을 손절가에서 닫으면 날릴 돈(수수료 포함)
      var loss = 0;
      for (var f = 0; f < pp.fills.length; f++) loss += d * (pp.fills[f].price - pp.stop) * pp.fills[f].units;
      return loss + pp.units * pp.stop * (fee + slip) + pp.cost * fee;
    }

    function addFill(i, wIdxOrWeight, notional) {
      var price = buyPx(i), units = notional / price;
      pos.fills.push({ price: price, units: units, w: wIdxOrWeight, i: i });
      pos.cost += notional; pos.units += units; pos.heldW += wIdxOrWeight;
      pos.avg = pos.cost / pos.units;
      pos.pnl -= notional * fee; equity -= notional * fee;
      pos.liq = lev > 1 ? (d > 0 ? pos.avg * (1 - 1 / lev + mmr) : pos.avg * (1 + 1 / lev - mmr)) : null;
    }

    function plannedNotional(i, w) {                                   // 이 단계에 넣을 금액(위험 한도·증거금 한도 반영)
      var want = pos.k0 * w;
      var px = buyPx(i), r = d * (px - pos.stop) / px;
      if (!(r > 0)) return 0;
      var rem = pos.R - riskAtStop(pos);
      var cap = rem / (r + 2 * (fee + slip));
      var room = equity * lev - pos.cost;
      return Math.max(0, Math.min(want, cap, room));
    }

    function open(i) {
      var px = buyPx(i), stop;
      if (d > 0) {
        stop = Infinity; for (var s = Math.max(0, i - P.swingLookback + 1); s <= i; s++) if (L[s] < stop) stop = L[s];
        stop = Math.max(stop, px * (1 - P.maxStopPct / 100)); stop = Math.min(stop, px * (1 - P.minStopPct / 100));
      } else {
        stop = -Infinity; for (var s2 = Math.max(0, i - P.swingLookback + 1); s2 <= i; s2++) if (H[s2] > stop) stop = H[s2];
        stop = Math.min(stop, px * (1 + P.maxStopPct / 100)); stop = Math.max(stop, px * (1 + P.minStopPct / 100));
      }
      if (AT && isNum(AT[i])) {                                        // ATR 손절: 변동성에 맞춰 폭을 정한다(최소·최대 폭은 그대로 적용)
        var raw = px - d * P.atrStopMult * AT[i];
        stop = d > 0 ? Math.min(Math.max(raw, px * (1 - P.maxStopPct / 100)), px * (1 - P.minStopPct / 100))
                     : Math.max(Math.min(raw, px * (1 + P.maxStopPct / 100)), px * (1 + P.minStopPct / 100));
      }
      var Eq = sizeEquity();
      var Rr = Eq * P.riskPct / 100;
      var dist = d * (px - stop) / px + 2 * (fee + slip);
      var total = Math.min(Rr / dist, Math.max(0, equity) * lev);
      pos = { fills: [], units: 0, cost: 0, avg: 0, heldW: 0, stop: stop, R: Rr, k0: total / sumW, openIdx: i,
              stage: 1, pnl: 0, liq: null, lastStageIdx: i, firstPx: px, cloudBreak: -1, flagA: false, flagB: false, cloudSeen: false, exited: false, E0: Eq };
      var first = P.mode === 'allin' ? sumW : W[0];
      var nn = plannedNotional(i, first);
      if (nn <= 0) { pos = null; return; }
      addFill(i, first, nn);
      if (P.mode === 'allin') pos.stage = W.length;
      stageReach[0]++;
      if (P.mode === 'allin') { stageReach[1]++; stageReach[2]++; }
    }

    function closeUnits(price, fraction) {                             // fraction 만큼(0~1) 보유분을 price 에 정리
      var u = pos.units * fraction, notional = u * price;
      var pnl = d * (price - pos.avg) * u - notional * fee;
      pos.pnl += pnl; equity += pnl;
      pos.units -= u; pos.cost -= pos.avg * u; pos.heldW -= pos.heldW * fraction;
      for (var f = 0; f < pos.fills.length; f++) pos.fills[f].units *= (1 - fraction);
    }

    function finish(i, reason) {
      pos.exited = true; lastClose = i;
      res.trades.push({ side: P.side, openIdx: pos.openIdx, closeIdx: i, openT: T[pos.openIdx], closeT: T[i],
        stages: pos.stage, avgEntry: pos.avg0 || pos.fills[0].price, stop: pos.stop, pnl: pos.pnl, R: pos.pnl / pos.R,
        retPct: 100 * pos.pnl / pos.E0, reason: reason });
      pos = null;
    }

    function markEquity(i) {
      var u = 0;
      if (pos) u = d * (C[i] - pos.avg) * pos.units;
      var e = equity + u;
      if (e > peak) peak = e;
      var dd = peak > 0 ? (peak - e) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      res.equity.push(e);
    }

    for (var i = 0; i < n; i++) {
      if (i < warm + 2) { res.equity.push(equity); continue; }
      if (bhStart === null) bhStart = i;

      if (pos) {
        exposure++;
        // 펀딩(롱이 내면 +, 숏이 받으면 −)
        if (fund !== 0) { var fc = pos.units * C[i] * fund; pos.pnl -= fc; equity -= fc; }
        // 손절 / 청산
        var stopHit = d > 0 ? L[i] <= pos.stop : H[i] >= pos.stop;
        var liqHit = pos.liq !== null && (d > 0 ? L[i] <= pos.liq : H[i] >= pos.liq);
        var liqFirst = liqHit && (d > 0 ? pos.liq >= pos.stop : pos.liq <= pos.stop);
        if (liqFirst) {
          closeUnits(pos.liq, 1); liqCount++; finish(i, 'liquidation'); markEquity(i); continue;
        }
        if (stopHit) {
          var fp = d > 0 ? Math.min(O[i], pos.stop) : Math.max(O[i], pos.stop);
          closeUnits(sellPx(fp), 1); finish(i, 'stop'); markEquity(i); continue;
        }
      }

      // 신호
      var rUp = R[i - 1] < P.rsiLow && R[i] >= P.rsiLow;               // RSI 가 30 아래에서 30 위로 복귀
      var rDn = R[i - 1] > P.rsiHigh && R[i] <= P.rsiHigh;             // (숏) 70 위에서 70 아래로
      var mUp = M.macd[i - 1] <= M.signal[i - 1] && M.macd[i] > M.signal[i];
      var mDn = M.macd[i - 1] >= M.signal[i - 1] && M.macd[i] < M.signal[i];
      var rsiCross50Down = R[i - 1] >= P.rsiExit && R[i] < P.rsiExit;
      var rsiCross50Up = R[i - 1] <= P.rsiExit && R[i] > P.rsiExit;
      var entrySig = d > 0 ? rUp : rDn;
      var macdConfirm = d > 0 ? mUp : mDn;
      var macdAgainst = d > 0 ? mDn : mUp;
      var rsiAgainst = d > 0 ? rsiCross50Down : rsiCross50Up;
      var top = I.top[i], bot = I.bottom[i];
      var beyondCloud = d > 0 ? C[i] > top : C[i] < bot;               // 구름 위(롱) / 아래(숏)
      var brokeCloud = d > 0 ? C[i] < bot : C[i] > top;                // 구름 반대편으로 무너짐

      if (!pos) {
        var trendOk = !TR || (P.trendMode === 'slope' ? d * (TR[i] - TR[i - 10]) > 0 : d > 0 ? C[i] > TR[i] : C[i] < TR[i]);
        if (entrySig && trendOk && i - lastClose > P.cooldownBars) open(i);
        markEquity(i);
        continue;
      }

      // 정리 신호(들어갈 때와 같은 1:2:6 순서로 줄인다)
      // 구름 이탈 청산은 가격이 구름 위(숏은 아래)에 올라선 적이 있을 때만 켠다.
      // 구름 아래에서 들어간 포지션이 진입 직후 "이탈"로 바로 정리되는 것을 막는다.
      if (beyondCloud) pos.cloudSeen = true;
      var exited = false;
      if (brokeCloud && pos.cloudSeen) { closeUnits(sellPx(C[i]), 1); finish(i, 'exit-cloud'); exited = true; }
      else {
        if (macdAgainst && !pos.flagA) {
          pos.flagA = true;
          closeUnits(sellPx(C[i]), Math.min(W[0], pos.heldW) / pos.heldW);
          if (pos.units < 1e-12 || pos.heldW < 1e-9) { finish(i, 'exit-macd'); exited = true; }
        }
        if (!exited && rsiAgainst && !pos.flagB) {
          pos.flagB = true;
          closeUnits(sellPx(C[i]), Math.min(W[1], pos.heldW) / pos.heldW);
          if (pos.units < 1e-12 || pos.heldW < 1e-9) { finish(i, 'exit-rsi'); exited = true; }
        }
      }
      if (exited) { markEquity(i); continue; }

      // 추가 진입
      if (!pos.flagA && !pos.flagB) {
        if (P.mode === 'ladder') {
          if (pos.stage === 1 && i - pos.lastStageIdx <= P.stageWindow && macdConfirm) {
            var n2 = plannedNotional(i, W[1]);
            if (n2 > 0) { addFill(i, W[1], n2); pos.stage = 2; pos.lastStageIdx = i; stageReach[1]++; if (beyondCloud) pos.cloudBreak = i; }
          } else if (pos.stage === 2) {
            if (pos.cloudBreak < 0) {
              if (beyondCloud) pos.cloudBreak = i;
            } else if (!beyondCloud && brokeCloud === false) {
              // 구름 안으로 들어왔다가 다시 나갈 때까지는 돌파 상태 유지
            }
            if (pos.cloudBreak >= 0 && i > pos.cloudBreak && i - pos.cloudBreak <= P.cloudWindow) {
              var tol = P.pullbackTolPct / 100;
              var touch = d > 0 ? (L[i] <= top * (1 + tol) && C[i] > top && C[i] > O[i])
                                : (H[i] >= bot * (1 - tol) && C[i] < bot && C[i] < O[i]);
              if (touch) {
                var n3 = plannedNotional(i, W[2]);
                if (n3 > 0) { addFill(i, W[2], n3); pos.stage = 3; pos.lastStageIdx = i; stageReach[2]++; }
              }
            } else if (pos.cloudBreak >= 0 && i - pos.cloudBreak > P.cloudWindow) {
              pos.cloudBreak = -1;                                     // 시간 초과 — 다음 돌파를 다시 기다린다
            }
          }
        } else if (P.mode === 'avgdown') {
          var step = P.avgDownStepPct / 100;
          var cur = pos.stage;                                         // 이미 채운 단계 수
          if (cur < W.length) {
            var trigger = pos.firstPx * (1 - d * step * cur);
            var hit = d > 0 ? C[i] <= trigger : C[i] >= trigger;
            if (hit) {
              var na = plannedNotional(i, W[cur]);
              if (na > 0) { addFill(i, W[cur], na); pos.stage = cur + 1; stageReach[cur]++; }
            }
          }
        }
      }
      markEquity(i);
    }
    // 마지막 칸에 열려 있는 포지션은 종가로 정리해 성과에 반영
    if (pos) { closeUnits(sellPx(C[n - 1]), 1); finish(n - 1, 'end'); res.equity[n - 1] = equity; }

    // 통계
    var wins = 0, losses = 0, gp = 0, gl = 0, sumR = 0, tr = res.trades;
    tr.forEach(function (t) { sumR += t.R; if (t.pnl > 0) { wins++; gp += t.pnl; } else { losses++; gl += -t.pnl; } });
    var years = (n - (bhStart || 0)) * P.barHours / 8766;
    var finalEq = equity;
    var bh = bhStart === null ? 0 : (C[n - 1] / C[bhStart] - 1);       // 같은 기간 단순 보유(현물 롱)
    res.stats = {
      bars: n, years: years, startEquity: P.startEquity, finalEquity: finalEq,
      totalReturnPct: 100 * (finalEq / P.startEquity - 1),
      cagrPct: years > 0 && finalEq > 0 ? 100 * (Math.pow(finalEq / P.startEquity, 1 / years) - 1) : NAN,
      maxDrawdownPct: 100 * maxDD,
      trades: tr.length, winRatePct: tr.length ? 100 * wins / tr.length : NAN,
      avgWin: wins ? gp / wins : 0, avgLoss: losses ? -gl / losses : 0,
      profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : NAN),
      expectancyR: tr.length ? sumR / tr.length : NAN,
      stageReach: stageReach.slice(), liquidations: liqCount,
      exposurePct: bhStart === null ? 0 : 100 * exposure / (n - bhStart),
      buyHoldReturnPct: 100 * bh                                        // 방향과 무관하게 롱 기준
    };
    return res;
  }

  return {
    rsi: rsi, ema: ema, sma: sma, atr: atr, macd: macd, ichimoku: ichimoku,
    sizePosition: sizePosition, backtest: backtest, DEFAULTS: DEFAULTS, DEFAULT_WEIGHTS: DEFAULT_WEIGHTS
  };
});
