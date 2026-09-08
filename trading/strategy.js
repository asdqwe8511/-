// 무손절 농장 전략 엔진.
// 글에 적힌 규칙을 그대로 옮긴 것이다.
//   1) 추세가 확인되기 전엔 안 들어간다(숏은 더 늦게)
//   2) 들어가면 한 파동을 통째로 간다
//   3) 역방향이 나오면 손절이 아니라 물량을 모은다
//   4) 롱숏을 같이 들되 주방향이 크고 보조방향이 작다
//   5) 목표가에 닿은 것만 판다
//   6) 하루 한 번만 본다
// 그리고 글에 없지만 계좌를 실제로 망가뜨리는 것들: 교차마진 청산, 펀딩비, 수수료.

const DEFAULTS = {
  startEquity: 5000,     // 시작 시드
  leverage: 3,           // 배율
  symbolCapPct: 0.25,    // 종목당 한도. 물타기 포함해서 시드의 25%
  cashBufferPct: 0.10,   // 항상 남겨 두는 여윳돈

  mainWeightPct: 0.080,  // 주방향 한 자리에 넣는 증거금(시드 대비)
  subWeightPct: 0.035,   // 보조방향(순환매) 한 자리
  addWeightPct: 0.060,   // 물타기 한 번에 더 넣는 증거금

  trendFast: 10,         // 추세 판단용 이동평균
  trendSlow: 30,
  confirmDays: 3,        // 이만큼 연속으로 같은 방향이어야 진입
  shortExtraConfirm: 2,  // 숏은 이만큼 더 기다린다

  mainTargetPct: 0.35,   // 주방향 목표가(평단 대비 가격 변화율)
  subTargetPct: 0.10,    // 보조방향은 짧게 먹는다
  addStepPct: 0.12,      // 평단에서 이만큼 밀리면 물을 탄다
  maxAdds: 3,            // 물타기 횟수 상한

  maxOpenSymbols: 8,     // 농장에 심는 밭의 개수
  maxNewPerDay: 2,       // 하루에 새로 여는 자리 수(아침에 한 번)

  feeRate: 0.0005,       // 진입/청산 수수료
  maintenanceRate: 0.005,// 유지증거금률. 교차마진 청산 기준
  intradayStress: 0.7,   // 장중 청산을 볼 때 종가에서 그날 최악까지 몇 %나 갔다고 볼지.
                         // 1 이면 모든 종목이 같은 순간에 저점/고점을 동시에 찍었다고 본다(가장 가혹).
  fundingOn: true,

  stopLossPct: null,     // null 이면 무손절. 0.2 면 증거금 20% 손실에서 자른다
  takeProfitOnFlip: true,// 추세가 꺾이면 이익 난 자리만 정리한다
};

function ema(values, span) {
  const k = 2 / (span + 1);
  const out = new Array(values.length);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// 종목 하나의 하루치 추세 판정. 1=상승확인, -1=하락확인, 0=아직
function trendSeries(closes, cfg) {
  const f = ema(closes, cfg.trendFast);
  const s = ema(closes, cfg.trendSlow);
  const raw = closes.map((c, t) => {
    if (t === 0) return 0;
    const up = f[t] > s[t] && s[t] > s[t - 1] && c > f[t];
    const dn = f[t] < s[t] && s[t] < s[t - 1] && c < f[t];
    return up ? 1 : dn ? -1 : 0;
  });
  // 연속 확인. 롱은 confirmDays, 숏은 더 길게.
  const needUp = cfg.confirmDays;
  const needDn = cfg.confirmDays + cfg.shortExtraConfirm;
  return raw.map((v, t) => {
    if (v === 0) return 0;
    const need = v === 1 ? needUp : needDn;
    if (t + 1 < need) return 0;
    for (let k = 0; k < need; k++) if (raw[t - k] !== v) return 0;
    return v;
  });
}

function runBacktest(market, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const { symbols, bars, funding } = market;
  const days = market.days;

  // 미리 계산: 종목별 추세, 시장 전체 지수의 추세(주방향)
  const trend = {};
  for (const s of symbols) trend[s] = trendSeries(bars[s].map((b) => b.c), cfg);

  const index = [];
  for (let t = 0; t < days; t++) {
    let sum = 0;
    for (const s of symbols) sum += bars[s][t].c / bars[s][0].c;
    index.push(sum / symbols.length);
  }
  const mainTrend = trendSeries(index, { ...cfg, confirmDays: 2, shortExtraConfirm: 0 });

  // 계좌 상태
  let cash = cfg.startEquity;
  let ruinDay = null;
  const positions = [];        // {sym, side, qty, avg, margin, adds, target, opened}
  const trades = [];
  const equityCurve = [];
  const log = [];
  let feesPaid = 0, fundingPaid = 0;

  const notional = (p, price) => Math.abs(p.qty) * price;
  const pnlOf = (p, price) => p.side * (price - p.avg) * p.qty;
  const priceOf = (s, t) => bars[s][t].c;

  // 그 종목의 그날 '최악의 순간' 가격. intradayStress 로 얼마나 가혹하게 볼지 정한다.
  const stressPrice = (p, t) => {
    const b = bars[p.sym][t];
    const ext = p.side === 1 ? b.l : b.h;
    return b.c + (ext - b.c) * cfg.intradayStress;
  };
  const equityAt = (t, mode = 'close') => {
    let eq = cash;
    for (const p of positions) {
      const px = mode === 'close' ? bars[p.sym][t].c : stressPrice(p, t);
      eq += pnlOf(p, px);
    }
    return eq;
  };
  const usedMargin = () => positions.reduce((a, p) => a + p.margin, 0);
  const symbolMargin = (sym) => positions.filter((p) => p.sym === sym).reduce((a, p) => a + p.margin, 0);

  const closePosition = (p, price, t, why) => {
    const pnl = pnlOf(p, price);
    const fee = notional(p, price) * cfg.feeRate;
    cash += pnl - fee;
    feesPaid += fee;
    trades.push({
      sym: p.sym, side: p.side, opened: p.opened, closed: t, held: t - p.opened,
      margin: p.margin, adds: p.adds, grossPnl: pnl, pnl: pnl - fee, why,
    });
    positions.splice(positions.indexOf(p), 1);
  };

  const openPosition = (sym, side, margin, targetPct, t, eqRef) => {
    const price = priceOf(sym, t);
    const qty = (margin * cfg.leverage) / price;
    const fee = margin * cfg.leverage * cfg.feeRate;
    cash -= fee;
    feesPaid += fee;
    positions.push({
      sym, side, qty, avg: price, margin, adds: 0, opened: t,
      targetPct, target: price * (1 + side * targetPct),
    });
    log.push({ t, kind: 'open', sym, side, margin, symbolMargin: symbolMargin(sym), equity: eqRef });
  };

  const addToPosition = (p, margin, t, eqRef) => {
    const price = priceOf(p.sym, t);
    const addQty = (margin * cfg.leverage) / price;
    const fee = margin * cfg.leverage * cfg.feeRate;
    cash -= fee;
    feesPaid += fee;
    p.avg = (p.avg * p.qty + price * addQty) / (p.qty + addQty);
    p.qty += addQty;
    p.margin += margin;
    p.adds += 1;
    p.target = p.avg * (1 + p.side * p.targetPct); // 목표가는 평단을 따라 내려온다
    log.push({ t, kind: 'add', sym: p.sym, side: p.side, margin, symbolMargin: symbolMargin(p.sym), equity: eqRef });
  };

  const start = Math.max(cfg.trendSlow + cfg.confirmDays + cfg.shortExtraConfirm, 2);
  for (let t = 0; t < days; t++) {
    if (ruinDay !== null) { equityCurve.push(0); continue; }

    // (1) 펀딩비. 양수면 롱이 낸다.
    if (cfg.fundingOn) {
      for (const p of positions) {
        const rate = funding[p.sym][t] || 0;
        const pay = notional(p, priceOf(p.sym, t)) * rate * p.side;
        cash -= pay;
        fundingPaid += pay;
      }
    }

    // (2) 장중. 먼저 청산부터 본다. 교차마진이라 전부 동시에 최악을 맞았다고 친다.
    if (positions.length) {
      const worst = equityAt(t, 'worst');
      const maint = positions.reduce((a, p) => a + notional(p, stressPrice(p, t)) * cfg.maintenanceRate, 0);
      if (worst <= maint) {
        log.push({ t, kind: 'liquidated', equity: worst });
        for (const p of [...positions]) closePosition(p, stressPrice(p, t), t, 'liquidated');
        cash = Math.max(cash, 0);
        ruinDay = t;
        equityCurve.push(0);
        continue;
      }
    }

    // (3) 목표가에 닿은 것만 판다. 손절선을 켰다면 여기서 같이 잘린다.
    for (const p of [...positions]) {
      const b = bars[p.sym][t];
      const hit = p.side === 1 ? b.h >= p.target : b.l <= p.target;
      if (hit) { closePosition(p, p.target, t, 'target'); continue; }
      if (cfg.stopLossPct !== null) {
        const loss = pnlOf(p, b.c);
        if (loss <= -cfg.stopLossPct * p.margin) closePosition(p, b.c, t, 'stop');
      }
    }

    // (4) 하루 한 번의 결정
    if (t >= start) {
      const eq = equityAt(t, 'close');
      const dir = mainTrend[t]; // 주방향

      // 추세가 꺾이면 이익 난 자리만 정리한다. 손실 난 자리는 그대로 둔다(무손절).
      if (cfg.takeProfitOnFlip) {
        for (const p of [...positions]) {
          const flipped = trend[p.sym][t] === -p.side;
          if (flipped && pnlOf(p, priceOf(p.sym, t)) > 0) closePosition(p, priceOf(p.sym, t), t, 'flip');
        }
      }

      // 물타기. 평단에서 밀린 만큼 단계적으로 더 산다.
      for (const p of positions) {
        if (p.adds >= cfg.maxAdds) continue;
        const px = priceOf(p.sym, t);
        const down = p.side * (px / p.avg - 1); // 음수면 물린 상태
        if (down > -cfg.addStepPct * (p.adds + 1)) continue;
        const want = eq * cfg.addWeightPct;
        const room = eq * cfg.symbolCapPct - symbolMargin(p.sym);
        const free = eq - usedMargin() - eq * cfg.cashBufferPct;
        const margin = Math.min(want, room, free);
        if (margin > eq * 0.005) addToPosition(p, margin, t, eq);
      }

      // 새 자리. 추세가 확인된 종목만, 하루 몇 개까지만.
      let opened = 0;
      const openSyms = new Set(positions.map((p) => p.sym));
      for (const sym of symbols) {
        if (opened >= cfg.maxNewPerDay) break;
        if (openSyms.size >= cfg.maxOpenSymbols && !openSyms.has(sym)) continue;
        const sig = trend[sym][t];
        if (sig === 0) continue;
        if (positions.some((p) => p.sym === sym && p.side === sig)) continue;
        if (positions.some((p) => p.sym === sym && p.side === -sig)) continue; // 같은 종목 양방은 안 든다
        const isMain = dir === 0 ? false : sig === dir;
        const want = eq * (isMain ? cfg.mainWeightPct : cfg.subWeightPct);
        const room = eq * cfg.symbolCapPct - symbolMargin(sym);
        const free = eq - usedMargin() - eq * cfg.cashBufferPct;
        const margin = Math.min(want, room, free);
        if (margin < want * 0.5) continue; // 반도 못 넣을 자리는 안 만든다
        openPosition(sym, sig, margin, isMain ? cfg.mainTargetPct : cfg.subTargetPct, t, eq);
        openSyms.add(sym);
        opened++;
      }
    }

    equityCurve.push(Math.max(equityAt(t, 'close'), 0));
    if (cfg.onDay) cfg.onDay({ t, equity: equityCurve[t], cash, positions: positions.map((p) => ({ ...p })) });
  }

  // 남은 자리는 마지막 종가로 평가만 하고 끝낸다(강제 청산 아님)
  const finalEquity = ruinDay !== null ? 0 : equityAt(days - 1, 'close');
  const openPnl = ruinDay !== null ? 0
    : positions.reduce((a, p) => a + pnlOf(p, priceOf(p.sym, days - 1)), 0);
  return {
    cfg, equityCurve, trades, log,
    finalEquity, ruined: ruinDay !== null, ruinDay,
    feesPaid, fundingPaid,
    openAtEnd: positions.map((p) => ({ ...p, pnl: ruinDay !== null ? 0 : pnlOf(p, priceOf(p.sym, days - 1)) })),
    openPnl,
    startEquity: cfg.startEquity,
  };
}

// 성적표
function metrics(res) {
  const eq = res.equityCurve;
  let peak = res.startEquity, mdd = 0, mddDay = 0;
  let worstDay = 0, worstDayIdx = 0, bestDay = 0;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] > peak) peak = eq[i];
    const dd = peak > 0 ? eq[i] / peak - 1 : 0;
    if (dd < mdd) { mdd = dd; mddDay = i; }
    if (i > 0 && eq[i - 1] > 0) {
      const r = eq[i] / eq[i - 1] - 1;
      if (r < worstDay) { worstDay = r; worstDayIdx = i; }
      if (r > bestDay) bestDay = r;
    }
  }
  const closed = res.trades.filter((t) => t.why !== 'liquidated');
  const wins = closed.filter((t) => t.pnl > 0);
  return {
    days: eq.length,
    multiple: res.finalEquity / res.startEquity,
    totalReturn: res.finalEquity / res.startEquity - 1,
    peakEquity: peak,
    peakMultiple: peak / res.startEquity,
    mdd, mddDay, worstDay, worstDayIdx, bestDay,
    ruined: res.ruined, ruinDay: res.ruinDay,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgHold: closed.length ? closed.reduce((a, t) => a + t.held, 0) / closed.length : 0,
    maxHold: closed.reduce((a, t) => Math.max(a, t.held), 0),
    fundingPaid: res.fundingPaid,
    feesPaid: res.feesPaid,
    openAtEnd: res.openAtEnd.length,
    openPnl: res.openPnl,
    openLosers: res.openAtEnd.filter((p) => p.pnl < 0).length,
    openLoss: res.openAtEnd.reduce((a, p) => a + Math.min(0, p.pnl), 0),
  };
}

module.exports = { runBacktest, metrics, trendSeries, ema, DEFAULTS };
