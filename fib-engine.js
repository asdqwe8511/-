// 피보나치 역산 엔진. 브라우저(trade.html)와 테스트(tools/test-fib.js)가 같은 파일을 쓴다.
//
// 캔들 한 개: { t: 시가 시각(ms), o, h, l, c, v }  — 반드시 "마감된" 봉만 넣는다.
// 지켜야 할 원칙(코드로 강제하는 것들)
//   · 미래 봉 정보 금지  : 피벗은 오른쪽 N봉이 닫혀야 확정(confirmedIndex). upTo 뒤의 봉은 읽지 않는다.
//   · 확정 시각 기록     : 피보 피팅에 쓴 피벗마다 confirmedAt 을 남긴다.
//   · 0 고정             : buildSnapshot 이 만든 스냅샷은 freeze. 새 피팅은 새 id(새 버전).
//   · 한 봉 SL/TP 동시   : simulateTrade 는 순서를 추측하지 않고 'ambiguous' 로 돌려준다.
//   · 거래비용 반영      : calcRR / computeR 은 수수료+슬리피지를 왕복으로 뺀다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FibEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786];

  const DEFAULTS = {
    pivotLeft: 5, pivotRight: 5,     // 피벗: 좌우 5봉 확정
    atrPeriod: 14, emaPeriod: 200,
    bodyRatio: 0.7,                  // 최초 돌파봉 몸통 비율
    breakAtr: 0.35,                  // 돌파 거리(ATR 배수)
    confirmBars: 3,                  // 돌파 후 연속 종가 확인 봉 수
    retestTolAtr: 0.1,               // 리테스트로 인정하는 레벨 근접 허용치(ATR 배수)
    slBufferAtr: 0.25,               // 리테스트 고/저점 바깥 SL 여유
    minRR: 3,                        // 비용 반영 손익비 하한
    feeRate: 0.0005,                 // 테이커 0.05% (편도)
    slipRate: 0.0002,                // 슬리피지 0.02% (편도)
    fitTol: 0.015,                   // 피벗이 피보 레벨에 "맞는다"고 보는 오차(구간 길이 대비)
    levels: LEVELS
  };

  const opt = (o) => Object.assign({}, DEFAULTS, o || {});
  const barMs = (c) => (c.length > 1 ? c[1].t - c[0].t : 900000);

  // ───────── 지표 ─────────
  // Wilder ATR. 값[i] 는 0..i 봉만 쓴다(인과적).
  function atr(c, n) {
    const out = new Array(c.length).fill(null);
    let prev = null, sum = 0;
    for (let i = 0; i < c.length; i++) {
      const tr = i === 0 ? c[i].h - c[i].l
        : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
      if (i < n) { sum += tr; if (i === n - 1) { prev = sum / n; out[i] = prev; } }
      else { prev = (prev * (n - 1) + tr) / n; out[i] = prev; }
    }
    return out;
  }

  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null, sum = 0;
    for (let i = 0; i < values.length; i++) {
      if (i < n) { sum += values[i]; if (i === n - 1) { prev = sum / n; out[i] = prev; } }
      else { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
    }
    return out;
  }

  // ───────── 피벗 ─────────
  // 고점: 왼쪽 N봉보다 엄격히 높고 오른쪽 N봉보다 같거나 높다(평평한 꼭대기는 첫 봉만).
  // confirmedIndex = i + right : 이 봉이 닫히는 순간에야 피벗이 "확정"된다.
  function findPivots(c, o) {
    o = opt(o);
    const L = o.pivotLeft, R = o.pivotRight;
    const upTo = o.upTo == null ? c.length - 1 : Math.min(o.upTo, c.length - 1);
    const ms = barMs(c);
    const out = [];
    for (let i = L; i + R <= upTo; i++) {
      let isH = true, isL = true;
      for (let k = 1; k <= L; k++) {
        if (!(c[i].h > c[i - k].h)) isH = false;
        if (!(c[i].l < c[i - k].l)) isL = false;
      }
      for (let k = 1; k <= R; k++) {
        if (!(c[i].h >= c[i + k].h)) isH = false;
        if (!(c[i].l <= c[i + k].l)) isL = false;
      }
      const confirmedAt = c[i + R].t + ms; // 확정 봉의 종가 시각
      if (isH) out.push({ index: i, type: 'H', price: c[i].h, time: c[i].t, confirmedIndex: i + R, confirmedAt });
      if (isL) out.push({ index: i, type: 'L', price: c[i].l, time: c[i].t, confirmedIndex: i + R, confirmedAt });
    }
    return out;
  }

  // ───────── 상위 시간프레임 ─────────
  // 15분봉을 groupMs 단위(UTC 정렬)로 묶는다. 다 차지 않은 마지막 묶음은 버린다.
  function resample(c, groupMs) {
    const ms = barMs(c), per = Math.round(groupMs / ms);
    const out = [];
    let cur = null, key = null, n = 0;
    for (const b of c) {
      const k = Math.floor(b.t / groupMs) * groupMs;
      if (k !== key) {
        if (cur && n === per) out.push(cur);
        key = k; n = 0;
        cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: 0 };
      }
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
      cur.c = b.c; cur.v += b.v || 0; n++;
    }
    if (cur && n === per) out.push(cur);
    return out;
  }

  // 추세: EMA20 vs EMA50 와 종가 위치가 모두 같은 쪽이어야 up/down, 아니면 flat.
  function trendOf(c) {
    if (c.length < 50) return { trend: 'flat', reason: '봉 부족(' + c.length + '/50)' };
    const cl = c.map((b) => b.c);
    const e20 = ema(cl, 20), e50 = ema(cl, 50), i = cl.length - 1;
    if (e20[i] > e50[i] && cl[i] > e50[i]) return { trend: 'up', ema20: e20[i], ema50: e50[i] };
    if (e20[i] < e50[i] && cl[i] < e50[i]) return { trend: 'down', ema20: e20[i], ema50: e50[i] };
    return { trend: 'flat', ema20: e20[i], ema50: e50[i] };
  }

  // i번째 15분봉이 닫힌 시점의 방향 판정. 0..i 만 본다.
  function biasAt(c, i, o) {
    o = opt(o);
    const s = c.slice(0, i + 1);
    const h4 = trendOf(resample(s, 4 * 3600000));
    const h1 = trendOf(resample(s, 3600000));
    const e = ema(s.map((b) => b.c), o.emaPeriod);
    const e200 = e[i];
    const m15 = e200 == null ? 'flat' : (s[i].c > e200 ? 'up' : s[i].c < e200 ? 'down' : 'flat');
    let dir = 'flat';
    if (h4.trend === 'up' && h1.trend === 'up' && m15 === 'up') dir = 'long';
    else if (h4.trend === 'down' && h1.trend === 'down' && m15 === 'down') dir = 'short';
    return { dir, h4: h4.trend, h1: h1.trend, m15, ema200: e200 };
  }

  // ───────── 손익비 / 비용 ─────────
  function costPrice(entry, o) { o = opt(o); return entry * 2 * (o.feeRate + o.slipRate); } // 왕복

  function calcRR(side, entry, sl, tp, o) {
    const long = side === 'long';
    if (long ? !(sl < entry && tp > entry) : !(sl > entry && tp < entry)) return null;
    const risk = Math.abs(entry - sl), reward = Math.abs(tp - entry), cost = costPrice(entry, o);
    return { risk, reward, cost, rrGross: reward / risk, rrNet: (reward - cost) / (risk + cost) };
  }

  // 체결 결과를 R(위험 단위)로. exit 가 SL 이면 -1R 보다 비용만큼 더 나쁘다.
  // 펀딩비: 정산 시각(UTC 00/08/16 시)에 포지션을 들고 있어야 낸다/받는다. 양(+)의 펀딩률이면 롱이 내고 숏이 받는다.
  //   o.funding = [{ t: 정산 시각 ms, rate: 소수, mark?: 정산 시점 마크가 }] (t 오름차순)
  // 반환: 코인 1개당 가격 단위의 지불액(지불 +, 수령 −).
  //   · 진입 봉 종가 시각(entryT) 이후 ~ 청산 이전의 정산만 센다.
  //   · 청산 봉 안의 정산은 그 봉 어디에서 청산됐는지 모르므로 "내는 경우만" 센다(받는 쪽을 유리하게 가정하지 않는다).
  //   · 진입 시각과 정확히 겹치는 정산도 같은 이유로 내는 경우만 센다.
  function fundingCostPrice(t, o) {
    const f = o && o.funding;
    if (!f || !f.length || t.entryT == null || (t.exitT == null && t.exitBarT == null)) return 0;
    const dir = t.side === 'long' ? 1 : -1, ms = t.barMs || 900000;
    let lo = 0, hi = f.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (f[m].t < t.entryT) lo = m + 1; else hi = m; } // 첫 f.t >= entryT
    let sum = 0;
    for (let i = lo; i < f.length; i++) {
      const s = f[i];
      if (t.exitT != null ? s.t >= t.exitT : s.t >= t.exitBarT + ms) break;
      const amt = dir * s.rate * (s.mark || t.entry);
      const ambiguous = s.t === t.entryT || (t.exitT == null && s.t >= t.exitBarT);
      if (ambiguous && amt <= 0) continue;
      sum += amt;
    }
    return sum;
  }

  function computeR(t, o) {
    const long = t.side === 'long';
    const risk = Math.abs(t.entry - t.sl);
    if (!(risk > 0)) return null;
    const gross = (long ? t.exit - t.entry : t.entry - t.exit) / risk;
    const costR = costPrice(t.entry, o) / risk;
    const fundingR = fundingCostPrice(t, o) / risk;
    return { gross, costR, fundingR, net: gross - costR - fundingR };
  }

  // ───────── 피보 레벨 / 피팅 ─────────
  const levelPrice = (P0, P1, ratio) => P0 + (P1 - P0) * ratio; // 0 = 종료점, 1 = 시작점

  // 시작점 1 이 고점('H')이면 하락 파동, 저점('L')이면 상승 파동.
  // 확정 피벗 p 가 레벨 L 에 놓인다고 가정하면  P0 = (p − L·P1) / (1 − L).
  // 후보마다 다른 확정 피벗이 다른 레벨에 몇 개 맞는지 세어 순위를 매긴다.
  function fitCandidates(c, spec, o) {
    o = opt(o);
    const asOf = spec.asOfIdx == null ? c.length - 1 : spec.asOfIdx;
    const st = spec.startIdx, kind = spec.startKind;
    const P1 = kind === 'H' ? c[st].h : c[st].l;
    const down = kind === 'H';
    let extreme = P1;
    for (let i = st; i <= asOf; i++) extreme = down ? Math.min(extreme, c[i].l) : Math.max(extreme, c[i].h);
    // o.pivots: 미리 계산해 둔 전체 피벗(백테스트용). confirmedIndex <= asOf 만 쓰므로 결과는 같다.
    const pivots = (o.pivots || findPivots(c, Object.assign({}, o, { upTo: asOf })))
      .filter((p) => p.index > st && p.confirmedIndex <= asOf);

    const raw = [];
    for (const p of pivots) {
      for (const L of o.levels) {
        const P0 = (p.price - L * P1) / (1 - L);
        if (down ? !(P0 < extreme && P0 < P1) : !(P0 > extreme && P0 > P1)) continue; // 아직 도달 안 한 미래 목표여야 함
        const range = Math.abs(P1 - P0);
        const byLevel = new Map();
        for (const q of pivots) {
          for (const lv of o.levels) {
            const err = Math.abs(q.price - levelPrice(P0, P1, lv));
            if (err <= o.fitTol * range) {
              const cur = byLevel.get(lv);
              if (!cur || err < cur.err) byLevel.set(lv, { pivot: q, level: lv, err });
            }
          }
        }
        const matches = [...byLevel.values()];
        raw.push({ P0, P1, down, range, matches, count: matches.length, errSum: matches.reduce((a, m) => a + m.err, 0) });
      }
    }
    raw.sort((a, b) => b.count - a.count || a.errSum / a.count - b.errSum / b.count);
    const out = [];
    for (const r of raw) { // 거의 같은 P0 는 가장 좋은 것 하나만
      if (out.some((x) => Math.abs(x.P0 - r.P0) <= 0.005 * x.range)) continue;
      out.push(r);
      if (out.length >= 8) break;
    }
    return out;
  }

  let seq = 0;
  // 스냅샷 = 신호 당시의 역산 0 을 고정해 둔 기록. freeze 이므로 사후 수정 불가, 새 피팅은 새 id.
  function buildSnapshot(c, spec, fit, o) {
    o = opt(o);
    const asOf = spec.asOfIdx == null ? c.length - 1 : spec.asOfIdx;
    const P1 = fit.P1, P0 = fit.P0;
    const snap = {
      id: 'fit-' + c[spec.startIdx].t + '-' + c[asOf].t + '-' + Math.round(P0 * 100) + '-' + (++seq),
      source: fit.manual ? 'manual' : 'auto',
      startTime: c[spec.startIdx].t, startKind: spec.startKind, P1, P0,
      direction: P0 < P1 ? 'down' : 'up',
      asOfTime: c[asOf].t + barMs(c),
      levels: o.levels.map((r) => ({ ratio: r, price: levelPrice(P0, P1, r) })),
      pivots: (fit.matches || []).map((m) => ({
        time: m.pivot.time, type: m.pivot.type, price: m.pivot.price,
        confirmedAt: m.pivot.confirmedAt, level: m.level, err: m.err
      })),
      params: { pivotLeft: o.pivotLeft, pivotRight: o.pivotRight, fitTol: o.fitTol, levels: o.levels }
    };
    return Object.freeze(snap);
  }

  // ───────── 돌파 / 리테스트 / 진입 후보 ─────────
  // 스냅샷의 P0 를 그대로 쓰고, 봉 i 의 판단에는 0..i 만 쓴다.
  function evaluateSetup(c, snap, o) {
    o = opt(o);
    const start = c.findIndex((b) => b.t === snap.startTime);
    if (start < 0) throw new Error('시작 봉이 캔들 데이터에 없습니다');
    const end = o.asOfIdx == null ? c.length - 1 : o.asOfIdx;
    const A = o._atr || atr(c, o.atrPeriod);
    const P0 = snap.P0, P1 = snap.P1, s = P0 < P1 ? -1 : 1; // s: 파동 진행 방향
    const side = s < 0 ? 'short' : 'long';
    const results = [];

    for (const lv of snap.levels) {
      const lp = lv.price;
      const r = { ratio: lv.ratio, price: lp, status: 'none', label: '미돌파', attempts: [], breakout: null, retest: null, entry: null };
      let state = 'scan';
      // fromIdx: 이 봉부터만 판정(백테스트에서 스냅샷이 만들어지기 전 봉은 보지 않는다)
      for (let i = Math.max(start + 1, o.fromIdx == null ? 0 : o.fromIdx); i <= end; i++) {
        const a = A[i];
        if (a == null) continue;
        const b = c[i];
        const beyond = (x) => s * (x - lp) > 0;

        if (state === 'scan') {
          if (!(beyond(b.c) && !beyond(c[i - 1].c))) continue;
          const range = b.h - b.l;
          const body = range > 0 ? Math.abs(b.c - b.o) / range : 0;
          const dist = s * (b.c - lp) / a;
          const why = [];
          if (!(s * (b.c - b.o) > 0)) why.push('돌파 방향 봉 아님');
          if (body < o.bodyRatio) why.push('몸통 ' + (body * 100).toFixed(0) + '% < ' + o.bodyRatio * 100 + '%');
          if (dist < o.breakAtr) why.push('거리 ' + dist.toFixed(2) + ' ATR < ' + o.breakAtr);
          if (why.length) { r.attempts.push({ index: i, time: b.t, ok: false, why: why.join(', ') }); continue; }
          if (i + o.confirmBars - 1 > end) {
            r.breakout = { index: i, time: b.t, body, distAtr: dist };
            r.status = 'confirming'; r.label = '돌파 확인 중 (' + (end - i + 1) + '/' + o.confirmBars + '봉)';
            break;
          }
          let ok = true;
          for (let k = 0; k < o.confirmBars; k++) if (!beyond(c[i + k].c)) ok = false;
          if (!ok) { r.attempts.push({ index: i, time: b.t, ok: false, why: o.confirmBars + '봉 연속 종가 미충족' }); continue; }
          r.breakout = { index: i, time: b.t, body, distAtr: dist, confirmIndex: i + o.confirmBars - 1, confirmTime: c[i + o.confirmBars - 1].t };
          r.attempts.push({ index: i, time: b.t, ok: true, why: '' });
          state = 'retest'; r.status = 'wait-retest'; r.label = '돌파 확정, 리테스트 대기';
          i += o.confirmBars - 1;
          continue;
        }

        if (state === 'retest') {
          // 진입 전에 목표 0 에 먼저 닿았으면 놓친 신호.
          if (s < 0 ? b.l <= P0 : b.h >= P0) { r.status = 'missed'; r.label = '진입 전 목표 0 도달(놓침)'; break; }
          const tol = o.retestTolAtr * a;
          const touched = s < 0 ? b.h >= lp - tol : b.l <= lp + tol;
          if (!touched) continue;
          if (!beyond(b.c)) { // 레벨을 도로 되찾음 → S/R 전환 실패, 다시 돌파를 기다림
            r.attempts.push({ index: i, time: b.t, ok: false, why: '리테스트 봉이 레벨 안쪽 마감(S/R 전환 실패)' });
            state = 'scan'; r.status = 'none'; r.label = '리테스트 실패, 재돌파 대기';
            continue;
          }
          let ext = s < 0 ? -Infinity : Infinity;
          for (let k = r.breakout.confirmIndex + 1; k <= i; k++) ext = s < 0 ? Math.max(ext, c[k].h) : Math.min(ext, c[k].l);
          const entry = b.c;
          const sl = s < 0 ? ext + o.slBufferAtr * a : ext - o.slBufferAtr * a;
          const rr = calcRR(side, entry, sl, P0, o);
          r.retest = { index: i, time: b.t, extreme: ext };
          r.entry = { index: i, time: b.t, side, price: entry, sl, tp: P0, atr: a, rr };
          const ok = rr && rr.rrNet >= o.minRR;
          r.status = ok ? 'candidate' : 'rr-fail';
          r.label = ok ? '진입 후보' : (rr ? '손익비 미달 (' + rr.rrNet.toFixed(2) + ' < ' + o.minRR + ')' : 'SL/TP 방향 오류');
          break;
        }
      }
      if (r.status === 'none' && state === 'retest') { r.status = 'wait-retest'; r.label = '돌파 확정, 리테스트 대기'; }
      results.push(r);
    }
    const candidates = results.filter((r) => r.status === 'candidate').sort((a, b) => a.entry.index - b.entry.index);
    return { side, levels: results, firstCandidate: candidates[0] || null };
  }

  // 진입 이후 봉을 순서대로 보며 SL/TP 판정. 한 봉에 둘 다 닿으면 순서를 추측하지 않는다.
  function simulateTrade(c, entryIdx, t, o) {
    return simulateManaged(c, entryIdx, t, o, { afterTarget: 'exit' });
  }

  // 진입 후 관리. afterTarget:
  //   'exit'    목표 0 에서 전량 청산
  //   'protect' 0 에 닿으면 SL 을 진입→목표 거리의 protectFrac 지점으로 옮기고 계속 보유
  //   'trail'   위와 같고, 이후 확정 스윙 고/저점(+ATR 여유)으로 SL 을 유리한 쪽으로만 옮김
  // 규칙: 한 봉에 최초 SL·TP 가 모두 닿으면 ambiguous. 0 에 닿은 봉에서 바꾼 SL 은 다음 봉부터 적용.
  function simulateManaged(c, entryIdx, t, o, st) {
    o = opt(o); st = Object.assign({ afterTarget: 'exit', protectFrac: 0.5 }, st || {});
    const long = t.side === 'long', end = o.endIdx == null ? c.length - 1 : Math.min(o.endIdx, c.length - 1); // endIdx: 이 봉까지만 본다(구간 검증용)
    const A = o._atr || atr(c, o.atrPeriod);
    const pv = st.afterTarget === 'trail' ? (o.pivots || findPivots(c, o)) : [];
    const byConf = new Map(); pv.forEach((p) => { if (!byConf.has(p.confirmedIndex)) byConf.set(p.confirmedIndex, []); byConf.get(p.confirmedIndex).push(p); });
    const ms = barMs(c), entryT = c[entryIdx].t + ms;
    // 청산 봉 i 에서 exit 가격으로 나갔을 때의 결과(펀딩 포함). exact: 봉 종가까지 들고 있었음(마지막 봉 평가)
    const RR = (exit, i, exact) => computeR({ side: t.side, entry: t.entry, sl: t.sl, exit, entryT, barMs: ms,
      exitT: exact ? c[i].t + ms : undefined, exitBarT: exact ? undefined : c[i].t }, o);
    const R = (exit, i, exact) => RR(exit, i, exact).net;
    const F = (exit, i, exact) => RR(exit, i, exact).fundingR;
    const protectSL = t.entry + (t.tp - t.entry) * st.protectFrac;
    let sl = t.sl, hit = false, hitIdx = null;
    for (let i = entryIdx + 1; i <= end; i++) {
      const b = c[i];
      if (hit && st.afterTarget === 'trail') {
        for (const p of byConf.get(i - 1) || []) {
          const a = A[i - 1] || 0;
          if (long && p.type === 'L') { const v = p.price - o.slBufferAtr * a; if (v > sl && v < c[i - 1].c) sl = v; }
          if (!long && p.type === 'H') { const v = p.price + o.slBufferAtr * a; if (v < sl && v > c[i - 1].c) sl = v; }
        }
      }
      const hitSL = long ? b.l <= sl : b.h >= sl;
      const hitTP = !hit && (long ? b.h >= t.tp : b.l <= t.tp);
      if (hitSL && hitTP) {
        return { outcome: 'ambiguous', exitIndex: i, targetHit: null, rWorst: R(t.sl, i),
          rBest: st.afterTarget === 'exit' ? R(t.tp, i) : R(protectSL, i),
          note: '같은 봉에서 SL·TP 가 모두 닿음 — 순서 불명' };
      }
      if (hitSL) return { outcome: hit ? 'protect-stop' : 'sl', exitIndex: i, exitPrice: sl, r: R(sl, i), fundingR: F(sl, i), targetHit: hit, targetIndex: hitIdx };
      if (hitTP) {
        if (st.afterTarget === 'exit') return { outcome: 'tp', exitIndex: i, exitPrice: t.tp, r: R(t.tp, i), fundingR: F(t.tp, i), targetHit: true, targetIndex: i };
        hit = true; hitIdx = i; sl = protectSL;
      }
    }
    // 데이터 끝까지 안 끝난 거래: 마지막 종가로 평가(r). 빼 버리면 보호 SL 전략의 수익 거래가 통계에서 사라진다.
    return { outcome: 'open', targetHit: hit, targetIndex: hitIdx, exitPrice: c[end].c, r: R(c[end].c, end, true), fundingR: F(c[end].c, end, true) };
  }

  // ───────── 백테스트 (걸어가며 재현) ─────────
  // 봉 i 에서 새 피벗이 확정될 때마다, 그 시점까지의 정보만으로
  //   · 최근 W 봉 안의 최고가(H)/최저가(L)를 시작점 1 로 삼고
  //   · 일치 레벨 수 ≥ btMinMatches 인 1순위 0 후보를 스냅샷으로 고정한다.
  // 같은 시작점에서 0 이 의미 있게 달라지면 새 스냅샷(새 버전)이고, 이전 것은 그 봉에서 끝난다.
  // 진입은 스냅샷 생성 이후 봉(돌파 포함)에서만 인정한다.
  function buildSnapshots(c, o) {
    o = opt(o);
    const W = o.btLookback || 300, minM = o.btMinMatches || 2, maxLife = o.btMaxLife || 500, minMove = o.btMinMoveAtr || 3;
    const A = atr(c, o.atrPeriod), pv = findPivots(c, o);
    const base = Object.assign({}, o, { pivots: pv, _atr: A });
    const byConf = new Map(); pv.forEach((p) => { if (!byConf.has(p.confirmedIndex)) byConf.set(p.confirmedIndex, []); byConf.get(p.confirmedIndex).push(p); });
    const snaps = [], last = new Map();
    const warm = Math.max(o.emaPeriod, W) ;
    for (let i = warm; i < c.length; i++) {
      if (!byConf.has(i) || A[i] == null) continue;
      let hi = -Infinity, hiI = -1, lo = Infinity, loI = -1;
      for (let k = i - W; k <= i; k++) { if (c[k].h > hi) { hi = c[k].h; hiI = k; } if (c[k].l < lo) { lo = c[k].l; loI = k; } }
      for (const kind of ['H', 'L']) {
        const st = kind === 'H' ? hiI : loI;
        if (st > i - o.pivotRight) continue; // 아직 확정 안 된 꼭짓점은 시작점이 될 수 없다
        if (!pv.some((p) => p.index === st && p.type === kind && p.confirmedIndex <= i)) continue;
        const P1 = kind === 'H' ? c[st].h : c[st].l;
        if (Math.abs(P1 - c[i].c) < minMove * A[i]) continue;
        const fit = fitCandidates(c, { startIdx: st, startKind: kind, asOfIdx: i }, base).find((f) => f.count >= minM);
        if (!fit) continue;
        const key = st + kind, prev = last.get(key);
        if (prev && Math.abs(prev.snap.P0 - fit.P0) <= 0.005 * fit.range) continue;
        const snap = buildSnapshot(c, { startIdx: st, startKind: kind, asOfIdx: i }, fit, o);
        const rec = { snap, k: i, startIdx: st, kind, end: null };
        if (prev) prev.end = i;
        last.set(key, rec); snaps.push(rec);
      }
    }
    // 각 스냅샷의 유효 구간: 다음 버전 직전 / 최대 수명 / 시작점을 넘어서는 새 극값 직전
    for (const r of snaps) {
      let end = Math.min(r.end == null ? c.length - 1 : r.end, r.k + maxLife, c.length - 1);
      const P1 = r.snap.P1;
      for (let j = r.k + 1; j <= end; j++) { if (r.kind === 'H' ? c[j].h > P1 : c[j].l < P1) { end = j - 1; break; } }
      r.validEnd = end;
      // 예측 지표: 이 0 에 실제로 도달했는가 (거래 수익성과 별개)
      const P0 = r.snap.P0; r.targetHitIdx = null;
      for (let j = r.k + 1; j < c.length && j <= r.k + maxLife; j++) { if (r.kind === 'H' ? c[j].l <= P0 : c[j].h >= P0) { r.targetHitIdx = j; break; } }
    }
    return { snaps, atr: A, pivots: pv };
  }

  // 스냅샷마다 돌파·리테스트·진입 후보를 평가한다. biasCache: 진입 봉 index → 방향 판정(조합끼리 공유).
  function evalSnapshots(c, B, o, biasCache) {
    o = opt(o);
    const base = Object.assign({}, o, { pivots: B.pivots, _atr: B.atr });
    const cands = [];
    for (const r of B.snaps) {
      const ev = evaluateSetup(c, r.snap, Object.assign({}, base, { asOfIdx: r.validEnd, fromIdx: r.k + 1 }));
      for (const lv of ev.levels) if (lv.status === 'candidate') cands.push({ rec: r, level: lv.ratio, e: lv.entry, breakout: lv.breakout });
    }
    cands.sort((a, b) => a.e.index - b.e.index || a.level - b.level);
    for (const x of cands) {
      let dir = biasCache && biasCache.get(x.e.index);
      if (dir == null) { dir = biasAt(c, x.e.index, o).dir; if (biasCache) biasCache.set(x.e.index, dir); }
      x.bias = dir; x.biasOk = dir === x.e.side;
    }
    return { snaps: B.snaps, candidates: cands, atr: B.atr, pivots: B.pivots };
  }

  function runBacktest(c, o) {
    o = opt(o);
    return evalSnapshots(c, buildSnapshots(c, o), o);
  }

  // 후보에 청산 전략을 입혀 거래 목록과 통계를 만든다. 한 번에 한 포지션만, 겹치는 신호는 건너뜀.
  // 한 레벨당 한 번만 진입하므로 SL 뒤에는 새 돌파·리테스트가 생기기 전까지 같은 신호가 다시 나오지 않는다.
  function tradeAll(c, bt, o, strat, useBias) {
    o = opt(o);
    const base = Object.assign({}, o, { pivots: bt.pivots, _atr: bt.atr });
    const trades = []; let busyUntil = -1, skipped = 0;
    for (const x of bt.candidates) {
      if (useBias && !x.biasOk) { skipped++; continue; }
      if (x.e.index <= busyUntil) { skipped++; continue; }
      const sim = simulateManaged(c, x.e.index, { side: x.e.side, entry: x.e.price, sl: x.e.sl, tp: x.e.tp }, base, strat);
      trades.push({ snapId: x.rec.snap.id, level: x.level, side: x.e.side, entryIndex: x.e.index, entryTime: c[x.e.index].t + barMs(c),
        entry: x.e.price, sl: x.e.sl, tp: x.e.tp, rrNet: x.e.rr.rrNet, bias: x.bias, sim });
      busyUntil = sim.outcome === 'open' ? Infinity : sim.exitIndex;
    }
    return { trades, skipped, stats: summarize(trades, bt) };
  }

  function summarize(trades, bt) {
    const done = trades; // 진행 중 거래도 마지막 종가 평가값(r)으로 포함
    const amb = done.filter((t) => t.sim.outcome === 'ambiguous');
    const series = (pick) => done.map((t) => (t.sim.outcome === 'ambiguous' ? t.sim[pick] : t.sim.r));
    const rW = series('rWorst'), rB = series('rBest'), sum = (a) => a.reduce((x, y) => x + y, 0);
    let eq = 0, peak = 0, dd = 0, streak = 0, ms = 0;
    rW.forEach((r) => { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); streak = r <= 0 ? streak + 1 : 0; ms = Math.max(ms, streak); });
    const gw = sum(rW.filter((r) => r > 0)), gl = -sum(rW.filter((r) => r < 0));
    const decided = done.filter((t) => t.sim.outcome !== 'ambiguous');
    const tgt = decided.filter((t) => t.sim.targetHit);
    const snaps = bt ? bt.snaps : [];
    return {
      n: done.length, open: trades.filter((t) => t.sim.outcome === 'open').length, ambiguous: amb.length,
      winRate: done.length ? rW.filter((r) => r > 0).length / done.length : null,
      avgR: done.length ? sum(rW) / done.length : null,
      totalRWorst: sum(rW), totalRBest: sum(rB),
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
      maxDD: dd, maxLossStreak: ms,
      avgFundingR: (() => { const f = done.filter((t) => typeof t.sim.fundingR === 'number'); return f.length ? sum(f.map((t) => t.sim.fundingR)) / f.length : null; })(),
      // 거래 안에서 목표 0 에 닿은 비율(예측) — 수익성(avgR)과 따로 본다
      tradeTargetRate: decided.length ? tgt.length / decided.length : null,
      snapCount: snaps.length,
      snapTargetRate: snaps.length ? snaps.filter((s) => s.targetHitIdx != null).length / snaps.length : null
    };
  }


  // ───────── 워크포워드 검증 ─────────
  // 학습 구간에서 파라미터 격자 중 최선을 고르고, 그 값을 바꾸지 않은 채 바로 뒤 검증 구간(OOS)에서 거래한다.
  // 구간을 앞으로 밀며 반복해 OOS 거래만 이어 붙인 성적이 "과최적화를 걸러낸" 성적이다.
  //   · 스냅샷·진입 후보는 전체 데이터에서 한 번 만들지만 모두 인과적이라(접두 불변) 구간 선택에 미래가 새지 않는다.
  //   · 학습 구간 청산 시뮬레이션은 학습 끝 봉에서 자른다(endIdx). 이후 봉의 결과가 파라미터 선택에 들어가지 않게.
  //   · 검증 구간 끝에서 안 끝난 거래는 종가로 평가해 포함한다.
  //   · 선택 기준은 거래 수를 반영한 t 값(평균 R / 표준오차). 학습 거래가 minTrades 미만이거나 t ≤ 0 이면 후보에서 뺀다.
  function rList(trades) { return trades.map((t) => (t.sim.outcome === 'ambiguous' ? t.sim.rWorst : t.sim.r)); }
  function tScore(trades, minTrades) {
    const r = rList(trades), n = r.length;
    if (n < minTrades) return -Infinity;
    const m = r.reduce((a, b) => a + b, 0) / n, v = r.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, n - 1);
    return v > 0 ? m / Math.sqrt(v / n) : (m > 0 ? Infinity : -Infinity);
  }
  const FIT_KEYS = ['pivotLeft', 'pivotRight', 'fitTol', 'atrPeriod', 'btLookback', 'btMinMatches', 'btMinMoveAtr', 'btMaxLife', 'emaPeriod'];

  function walkForward(c, o, cfg) {
    o = opt(o);
    cfg = Object.assign({ trainBars: 6000, testBars: 2000, stepBars: null, grid: {}, strat: { afterTarget: 'exit', protectFrac: 0.5 },
      useBias: true, minTrades: 8, warmBars: 1000, onProgress: null }, cfg || {});
    const n = c.length, step = cfg.stepBars || cfg.testBars, ms = barMs(c);
    const folds = [];
    for (let a = cfg.warmBars; a + cfg.trainBars + cfg.testBars <= n; a += step) {
      folds.push({ trainStart: a, trainEnd: a + cfg.trainBars - 1, testStart: a + cfg.trainBars, testEnd: a + cfg.trainBars + cfg.testBars - 1 });
    }
    if (!folds.length) throw new Error('봉이 부족합니다: 최소 ' + (cfg.warmBars + cfg.trainBars + cfg.testBars) + '봉 필요 (현재 ' + n + ')');

    // 조합: 격자의 곱 + 현재 값 그대로(기준선). 기준선은 선택 없이 항상 같은 값으로 거래한다.
    const keys = Object.keys(cfg.grid).filter((k) => cfg.grid[k] && cfg.grid[k].length);
    let combos = [{}];
    keys.forEach((k) => { const nx = []; combos.forEach((cb) => cfg.grid[k].forEach((v) => nx.push(Object.assign({}, cb, { [k]: v })))); combos = nx; });
    const baseline = { id: 'base', over: {}, P: o };
    const list = combos.map((over, i) => ({ id: 'c' + i, over, P: Object.assign({}, o, over) }));
    list.push(baseline);

    const builds = new Map(), bias = new Map(), total = list.length;
    let done = 0;
    for (const cb of list) {
      const fk = FIT_KEYS.map((k) => cb.P[k]).join('|');
      if (!builds.has(fk)) builds.set(fk, buildSnapshots(c, cb.P));
      cb.bt = evalSnapshots(c, builds.get(fk), cb.P, bias);
      if (cfg.onProgress) cfg.onProgress(++done, total);
    }

    const seg = (cb, a, b) => {
      const bt = Object.assign({}, cb.bt, { candidates: cb.bt.candidates.filter((x) => x.e.index >= a && x.e.index <= b) });
      return tradeAll(c, bt, Object.assign({}, cb.P, { endIdx: b }), cfg.strat, cfg.useBias).trades;
    };
    const oosTrades = [], baseTrades = [], isStatsList = [], stability = {};
    const out = [];
    for (const f of folds) {
      let best = null, bestScore = -Infinity, qualified = 0;
      for (const cb of list) {
        if (cb === baseline) continue;
        const sc = tScore(seg(cb, f.trainStart, f.trainEnd), cfg.minTrades);
        if (sc > -Infinity) qualified++;
        if (sc > 0 && sc > bestScore) { bestScore = sc; best = cb; } // 학습에서도 손해인 조합은 고르지 않는다
      }
      const row = { train: [c[f.trainStart].t, c[f.trainEnd].t + ms], test: [c[f.testStart].t, c[f.testEnd].t + ms], qualified };
      const bTr = seg(baseline, f.testStart, f.testEnd);
      row.baseOos = summarize(bTr, null); baseTrades.push(...bTr);
      if (best && bestScore > -Infinity) {
        const isT = seg(best, f.trainStart, f.trainEnd), oT = seg(best, f.testStart, f.testEnd);
        row.chosen = best.over; row.score = bestScore; row.isStats = summarize(isT, null); row.oosStats = summarize(oT, null);
        oosTrades.push(...oT); isStatsList.push(row.isStats);
        Object.keys(best.over).forEach((k) => { (stability[k] = stability[k] || {})[best.over[k]] = ((stability[k] || {})[best.over[k]] || 0) + 1; });
      } else { row.chosen = null; row.note = qualified ? '학습 구간에서 이익이 난 조합이 없음 — 이 구간은 거래하지 않음' : '학습 구간 거래가 ' + cfg.minTrades + '건 미만 — 이 구간은 거래하지 않음'; }
      out.push(row);
    }
    const isN = isStatsList.reduce((a, s) => a + s.n, 0);
    return {
      cfg: { trainBars: cfg.trainBars, testBars: cfg.testBars, stepBars: step, grid: cfg.grid, strat: cfg.strat, useBias: cfg.useBias, minTrades: cfg.minTrades },
      combos: total - 1, folds: out, stability,
      oos: summarize(oosTrades, null), baseOos: summarize(baseTrades, null),
      isAvgR: isN ? isStatsList.reduce((a, s) => a + s.avgR * s.n, 0) / isN : null, isTrades: isN,
      oosTrades, baseTrades,
      positiveFolds: out.filter((r) => r.oosStats && r.oosStats.n && r.oosStats.avgR > 0).length,
      tradedFolds: out.filter((r) => r.oosStats && r.oosStats.n).length
    };
  }

  // 수동으로 분석해 둔 목표값과 자동 계산값의 차이.
  function compareManual(manual, auto, atrValue) {
    const diff = auto - manual;
    return { diff, pct: manual ? diff / manual * 100 : null, atr: atrValue ? diff / atrValue : null };
  }

  // ───────── 위험 관리 ─────────
  // 손절 시 비용까지 포함해 정확히 riskPct 만 잃도록 수량을 정한다.
  function positionSize(p, o) {
    o = opt(o);
    const long = p.side === 'long';
    const risk = Math.abs(p.entry - p.sl) + costPrice(p.entry, o);
    const riskAmt = p.balance * p.riskPct / 100;
    const qty = riskAmt / risk;
    const notional = qty * p.entry;
    const margin = notional / p.leverage;
    const mmr = p.mmr == null ? 0.004 : p.mmr;
    // 격리 마진 근사치. 거래소 실제 청산가와 다를 수 있다(유지증거금 구간, 펀딩 등).
    const liq = long ? p.entry * (1 - 1 / p.leverage + mmr) : p.entry * (1 + 1 / p.leverage - mmr);
    const funding = notional * (p.fundingRate || 0) * ((p.holdHours || 0) / 8);
    const liqBeforeSL = long ? liq >= p.sl : liq <= p.sl;
    return { riskAmt, qty, notional, margin, liq, funding, liqBeforeSL,
      marginPct: p.balance ? margin / p.balance * 100 : null };
  }

  // ───────── 매매일지 통계 ─────────
  function journalStats(entries) {
    const closed = entries.filter((e) => typeof e.r === 'number');
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const avg = (a) => (a.length ? sum(a) / a.length : null);
    const wins = closed.filter((e) => e.r > 0);
    const followed = closed.filter((e) => e.followed), broke = closed.filter((e) => !e.followed);
    let streak = 0, maxLoss = 0;
    closed.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((e) => {
      streak = e.r <= 0 ? streak + 1 : 0; maxLoss = Math.max(maxLoss, streak);
    });
    const tags = {};
    entries.forEach((e) => (e.emotions || []).forEach((t) => { tags[t] = (tags[t] || 0) + 1; }));
    return {
      total: entries.length, closed: closed.length,
      winRate: closed.length ? wins.length / closed.length : null,
      totalR: sum(closed.map((e) => e.r)), avgR: avg(closed.map((e) => e.r)),
      adherence: closed.length ? followed.length / closed.length : null,
      avgRFollowed: avg(followed.map((e) => e.r)), avgRBroke: avg(broke.map((e) => e.r)),
      nFollowed: followed.length, nBroke: broke.length, maxLossStreak: maxLoss, tags
    };
  }

  return { LEVELS, DEFAULTS, atr, ema, findPivots, resample, trendOf, biasAt, calcRR, computeR, costPrice,
    levelPrice, fitCandidates, buildSnapshot, evaluateSetup, simulateTrade, simulateManaged, buildSnapshots, evalSnapshots, runBacktest, tradeAll, summarize, walkForward, tScore, compareManual, positionSize, journalStats, fundingCostPrice };
});
