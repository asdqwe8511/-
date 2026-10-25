/* EMA200 리테스트 전략 엔진 (BTC 선물 4시간봉).
 *
 * 브라우저(<script src="/trade-engine.js">)와 Node(require) 양쪽에서 같은 코드를
 * 씁니다. 화면의 상태 패널과 백테스트가 같은 규칙에서 나와야 하기 때문입니다.
 *
 * 규칙 (숏 기준, 롱은 대칭)
 *   1. 일봉 EMA200 : 마지막으로 마감한 일봉 종가가 아래면 하방, 위면 상방.
 *   2. 4시간봉 EMA200 위치가 1번과 같은 쪽일 때만 진입을 본다. 다르면 관망.
 *   3. 이탈봉 : 몸통의 절반 이상이 EMA200 반대편에서 마감한 4시간봉.
 *   4. 리테스트 : 이탈 뒤 봉이 EMA200 선에 닿았다가(꼬리 포함) 원래 방향으로
 *      마감하면, 그 봉의 종가에서 진입. 마감 확인 전에는 들어가지 않는다.
 *   5. 손절 : 진입 뒤 몸통의 절반 이상이 반대편에서 마감한 4시간봉이 나오면 그 봉
 *      종가에서 청산. 꼬리로 선을 찌르는 것만으로는 손절하지 않는다.
 *   6. 한 구간에 한 번 : 같은 이탈 구간에서는 신호를 한 번만 낸다. 반대편 이탈봉이
 *      나오면 구간이 끝나고 처음부터 다시 시작한다.
 *   (오더블록 익절은 아직 규칙이 정해지지 않아 넣지 않았다.)
 *
 * 캔들은 { t, o, h, l, c } (t = 시작 시각 ms) 배열, 오래된 것부터.
 * 마감하지 않은 마지막 봉은 호출하는 쪽에서 미리 빼고 넣는다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TradeEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_MS = 86400000;
  var H4_MS = 4 * 3600000;

  // 종가 기준 EMA. 앞쪽 period-1 개는 값이 없어 null (SMA 로 시작하는 표준 방식).
  function ema(closes, period) {
    var out = new Array(closes.length);
    var k = 2 / (period + 1), sum = 0, prev = null;
    for (var i = 0; i < closes.length; i++) {
      if (i < period - 1) { sum += closes[i]; out[i] = null; continue; }
      if (i === period - 1) { sum += closes[i]; prev = sum / period; out[i] = prev; continue; }
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // 몸통 중 EMA 아래에 있는 비율(0~1). 몸통이 없는 도지는 종가 쪽으로 몰아 준다.
  function bodyBelow(c, e) {
    var lo = Math.min(c.o, c.c), hi = Math.max(c.o, c.c);
    if (hi === lo) return c.c < e ? 1 : 0;
    return Math.max(0, Math.min(1, (Math.min(hi, e) - lo) / (hi - lo)));
  }

  // 일봉 EMA200 방향. 4시간봉 시각 t 에 이미 마감돼 있던 마지막 일봉 기준.
  // 일봉 시작이 UTC 00:00 이므로 마감 시각 = 시작 + 1일.
  function dailyBias(daily, dailyEma, t) {
    var lo = 0, hi = daily.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (daily[mid].t + DAY_MS <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0 || dailyEma[idx] == null) return null;
    return { dir: daily[idx].c < dailyEma[idx] ? 'short' : 'long', close: daily[idx].c, ema: dailyEma[idx] };
  }

  /* 전체 이력을 한 번 훑어 거래와 현재 상태를 낸다.
   * opts.threshold : "절반" 기준 (기본 0.5)
   * opts.fee       : 편도 수수료 비율 (기본 0.0004 = 0.04%)
   */
  function run(h4, daily, opts) {
    opts = opts || {};
    var th = opts.threshold == null ? 0.5 : opts.threshold;
    var fee = opts.fee == null ? 0.0004 : opts.fee;
    var e4 = ema(h4.map(function (c) { return c.c; }), 200);
    var eD = ema(daily.map(function (c) { return c.c; }), 200);

    var trades = [], events = [];
    var armed = null;   // { dir, idx }  이탈 확인 뒤 리테스트 대기
    var pos = null;     // { dir, idx, price, worst }

    for (var i = 0; i < h4.length; i++) {
      var c = h4[i], e = e4[i];
      if (e == null) continue;
      var below = bodyBelow(c, e);
      var eps = e * 1e-9;                               // 부동소수 오차로 선 위에 서 있는 봉이 이탈로 잡히지 않게
      var bearBreak = c.c < e - eps && below >= th;          // 아래로 이탈한 봉
      var bullBreak = c.c > e + eps && (1 - below) >= th;    // 위로 이탈한 봉

      if (pos) {
        // 보유 중: 반대편으로 몸통 절반 이상 마감하면 청산
        var against = pos.dir === 'short' ? bullBreak : bearBreak;
        var adverse = pos.dir === 'short' ? (c.h - pos.price) / pos.price : (pos.price - c.l) / pos.price;
        if (adverse > pos.worst) pos.worst = adverse;
        if (against) {
          var gross = pos.dir === 'short' ? (pos.price - c.c) / pos.price : (c.c - pos.price) / pos.price;
          trades.push({ dir: pos.dir, entryIdx: pos.idx, exitIdx: i, entryT: h4[pos.idx].t, exitT: c.t,
            entry: pos.price, exit: c.c, pnl: gross - 2 * fee, mae: pos.worst, reason: 'stop', bars: i - pos.idx });
          events.push({ i: i, type: 'stop', dir: pos.dir });
          pos = null;
          // 반대편 이탈봉이 곧 새 구간의 시작이다.
          armed = { dir: bullBreak ? 'long' : 'short', idx: i };
          events.push({ i: i, type: 'break', dir: armed.dir });
        }
        continue;
      }

      if (armed) {
        // 반대편 이탈봉이 나오면 대기 취소, 그 봉이 새 구간의 시작
        var cancel = armed.dir === 'short' ? bullBreak : bearBreak;
        if (cancel) {
          armed = { dir: armed.dir === 'short' ? 'long' : 'short', idx: i };
          events.push({ i: i, type: 'break', dir: armed.dir });
          continue;
        }
        var touched = armed.dir === 'short' ? c.h >= e : c.l <= e;
        var held = armed.dir === 'short' ? c.c < e : c.c > e;
        if (i > armed.idx && touched && held) {
          var bias = dailyBias(daily, eD, c.t);
          if (bias && bias.dir === armed.dir) {
            pos = { dir: armed.dir, idx: i, price: c.c, worst: 0 };
            events.push({ i: i, type: 'entry', dir: armed.dir });
            armed = null;      // 한 구간에 한 번: 청산(=반대편 이탈봉) 전까지 재무장 없음
          } else {
            events.push({ i: i, type: 'skip', dir: armed.dir });
          }
        }
        continue;
      }

      if (bearBreak) { armed = { dir: 'short', idx: i }; events.push({ i: i, type: 'break', dir: 'short' }); }
      else if (bullBreak) { armed = { dir: 'long', idx: i }; events.push({ i: i, type: 'break', dir: 'long' }); }
    }

    return { trades: trades, events: events, ema4h: e4, emaDaily: eD, state: describe(h4, daily, e4, eD, armed, pos, th) };
  }

  // 마지막 마감 봉 시점의 상태 한 줄 요약
  function describe(h4, daily, e4, eD, armed, pos, th) {
    var i = h4.length - 1;
    if (i < 0 || e4[i] == null) return { stage: 'nodata', text: '데이터가 부족합니다 (EMA200 계산에 200개 이상 필요)' };
    var c = h4[i], e = e4[i];
    var bias = dailyBias(daily, eD, c.t + H4_MS);
    var side4 = c.c < e ? 'short' : 'long';
    var out = { bias: bias, side4h: side4, close: c.c, ema4h: e, distPct: (c.c - e) / e, aligned: !!bias && bias.dir === side4 };
    if (pos) {
      out.stage = 'holding'; out.dir = pos.dir; out.entry = pos.price;
      out.pnl = pos.dir === 'short' ? (pos.price - c.c) / pos.price : (c.c - pos.price) / pos.price;
      out.stopLine = e;
    } else if (armed) {
      out.stage = out.aligned && armed.dir === bias.dir ? 'waiting' : 'blocked'; out.dir = armed.dir;
      out.barsSince = i - armed.idx;
    } else {
      out.stage = 'idle';
    }
    return out;
  }

  function summarize(trades) {
    var n = trades.length;
    if (!n) return { n: 0 };
    var wins = trades.filter(function (t) { return t.pnl > 0; });
    var sum = trades.reduce(function (a, t) { return a + t.pnl; }, 0);
    var gw = wins.reduce(function (a, t) { return a + t.pnl; }, 0);
    var gl = trades.filter(function (t) { return t.pnl <= 0; }).reduce(function (a, t) { return a - t.pnl; }, 0);
    var eq = 1, peak = 1, mdd = 0;
    trades.forEach(function (t) { eq *= 1 + t.pnl; if (eq > peak) peak = eq; mdd = Math.max(mdd, 1 - eq / peak); });
    return { n: n, winRate: wins.length / n, avg: sum / n, total: eq - 1, profitFactor: gl ? gw / gl : null,
      maxDrawdown: mdd, avgMae: trades.reduce(function (a, t) { return a + t.mae; }, 0) / n,
      avgBars: trades.reduce(function (a, t) { return a + t.bars; }, 0) / n };
  }

  return { ema: ema, bodyBelow: bodyBelow, dailyBias: dailyBias, run: run, summarize: summarize, H4_MS: H4_MS, DAY_MS: DAY_MS };
});
