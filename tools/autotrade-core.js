// 자동매매의 판단 부분. 거래소를 모른 채 "지금 무엇을 해야 하나"만 계산한다.
//
// 백테스트 엔진(position-engine.js)에 최근 닫힌 일봉들을 통째로 넣고 돌려서, 가장 최근
// 칸에서 벌어진 행동(open/add/reduce/close)만 꺼낸다. 백테스트와 실매매가 같은 규칙을
// 쓰도록 판단 코드를 따로 두지 않는다. 거래소에 이미 있는 포지션과 맞춰 보고, 맞지 않으면
// 건드리지 않고 알린다(이중 진입·유령 청산 방지).
const E = require('../position-engine.js');

const DAY_MS = 86400000;

/** 닫힌 일봉만 남긴다(진행 중인 오늘 봉은 신호에 쓰지 않는다). */
function closedCandles(candles, nowMs) {
  return candles.filter(c => c.t + DAY_MS <= nowMs);
}

/**
 * input
 *   candles   최근 일봉 [{t,o,h,l,c}] (닫힌 것만, 시간순). 1000개 안팎이면 지표가 충분히 수렴한다.
 *   balance   선물 지갑 잔고(USDT)
 *   position  거래소의 현재 포지션 { qty: 부호 있는 수량(롱 +, 숏 −), entryPrice }
 *   params    { side, riskPct, leverage, trendMaPeriod, trendMode, atrStopMult, cooldownBars, ... } (엔진 옵션)
 *   state     { lastBarT, stop } 지난번에 처리한 칸과 손절가
 *   nowMs     기준 시각
 * returns { actions, notes, barT, skip }
 *   actions: [{ kind:'open'|'add'|'reduce'|'close', side, notional?, fraction?, stop?, reason, tag }]
 */
function decide(input) {
  const { balance, position, params, state, nowMs } = input;
  const notes = [];
  const candles = closedCandles(input.candles, nowMs);
  const out = { actions: [], notes: notes, barT: null, skip: false };
  if (candles.length < 200) { notes.push('닫힌 캔들이 ' + candles.length + '개뿐입니다. 200개 이상 필요합니다.'); out.skip = true; return out; }
  const last = candles[candles.length - 1];
  out.barT = last.t;
  if (nowMs - (last.t + DAY_MS) > 2 * DAY_MS) {
    notes.push('마지막 닫힌 봉(' + new Date(last.t).toISOString().slice(0, 10) + ')이 이틀 넘게 지났습니다. 시세가 끊겼을 수 있어 건너뜁니다.');
    out.skip = true; return out;
  }
  if (state && state.lastBarT === last.t) { notes.push('이 봉은 이미 처리했습니다.'); out.skip = true; return out; }
  if (!(balance > 0)) { notes.push('잔고를 읽지 못했습니다.'); out.skip = true; return out; }

  const side = params.side === 'short' ? 'short' : 'long';
  const dir = side === 'long' ? 1 : -1;
  // 실제 잔고 기준 고정 비율로 크기를 정한다(복리 시뮬레이션과 실계좌가 어긋나는 것을 피함).
  const opts = Object.assign({}, params, { side, mode: 'ladder', startEquity: balance, compound: false });
  const bt = E.backtest(candles, opts);
  const lastIdx = candles.length - 1;
  const events = bt.events.filter(e => e.i === lastIdx);
  const qty = position ? position.qty : 0;
  const has = Math.abs(qty) > 0;
  const sameSide = has && Math.sign(qty) === dir;

  if (has && !sameSide) { notes.push('거래소에 반대 방향 포지션이 있습니다. 건드리지 않습니다(직접 확인하세요).'); out.skip = true; return out; }

  for (const ev of events) {
    if (ev.type === 'open') {
      if (has) { notes.push('진입 신호지만 이미 포지션이 있어 건너뜁니다.'); continue; }
      out.actions.push({ kind: 'open', side, notional: ev.notional, stop: ev.stop, reason: 'stage1', tag: 'open' });
    } else if (ev.type === 'add') {
      if (!sameSide) { notes.push((ev.stage) + '단계 추가 신호지만 이 봇의 포지션이 없어 건너뜁니다.'); continue; }
      out.actions.push({ kind: 'add', side, notional: ev.notional, reason: 'stage' + ev.stage, tag: 'add' + ev.stage });
    } else if (ev.type === 'reduce') {
      if (!sameSide) { notes.push('감축 신호지만 포지션이 없습니다.'); continue; }
      out.actions.push({ kind: 'reduce', side, fraction: ev.fraction, reason: ev.reason, tag: ev.reason });
    } else if (ev.type === 'close') {
      if (!sameSide) continue;                                       // 이미 거래소 손절로 닫힌 경우 포함
      out.actions.push({ kind: 'close', side, reason: ev.reason, tag: ev.reason });
    }
  }
  if (!events.length) notes.push('이 봉에서 할 일이 없습니다.');
  return out;
}

/** 하루 손실 한도. 하루 시작 자산 대비 equity 가 limitPct 이상 줄면 멈춘다. */
function killSwitch(state, equity, limitPct, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const s = Object.assign({}, state);
  if (s.dayKey !== day) { s.dayKey = day; s.dayStartEquity = equity; }
  const lossPct = s.dayStartEquity > 0 ? 100 * (s.dayStartEquity - equity) / s.dayStartEquity : 0;
  const tripped = lossPct >= limitPct;
  return { state: s, tripped, lossPct };
}

/** 거래소 필터(수량 단위·최소 금액)에 맞춰 수량을 내림한다. 못 맞추면 null. */
function roundQty(qty, filters) {
  const step = filters.stepSize;
  const q = Math.floor(qty / step + 1e-9) * step;
  const dec = (String(step).split('.')[1] || '').length;
  const r = +q.toFixed(dec);
  if (r < filters.minQty) return null;
  return r;
}

module.exports = { decide, killSwitch, roundQty, closedCandles, DAY_MS };
