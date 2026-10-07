'use strict';
// 코인 하나의 상태 기계. 거래소 호출 없이 "무엇을 해야 하는지"만 돌려준다.
//  WATCH : 지지선/저항선 트리거 대기
//  OPEN  : 첫 진입. 스탑 없음, 청산까지 방치 (규칙5)
//  LOCKED: 방향이 ±10% 적중 → 물량은 그대로 두고 손절선만 설정 (규칙2).
//          손절선 = 진입가 + (최대 유리 이동폭 × lockFraction). 1일 1회, 유리한 쪽으로만 수정 (규칙3)

const newState = () => ({ phase: 'WATCH', cooldownUntil: 0 });

function favorable(st, price) {
  return st.side === 'long' ? (price - st.entry) / st.entry : (st.entry - price) / st.entry;
}

// 극값(롱은 고점, 숏은 저점)의 이익 중 lockFraction 만큼을 지키는 가격
function lockPrice(st, cfg) {
  const move = favorable(st, st.peak) * cfg.stopLockFraction;
  return st.side === 'long' ? st.entry * (1 + move) : st.entry * (1 - move);
}

function step(st, price, now, cfg, levels) {
  const acts = [];
  if (st.phase === 'WATCH') {
    if (now < st.cooldownUntil || !levels) return acts;
    if (levels.support && price <= levels.support.price)
      acts.push({ type: 'ENTER', side: 'long', level: levels.support.price });
    else if (levels.resistance && price >= levels.resistance.price)
      acts.push({ type: 'ENTER', side: 'short', level: levels.resistance.price });
    return acts;
  }

  const better = st.side === 'long' ? price > st.peak : price < st.peak;
  if (better) st.peak = price;

  if (st.phase === 'OPEN') {
    if (favorable(st, st.peak) >= cfg.takeProfitMove) {
      st.phase = 'LOCKED';
      st.stop = lockPrice(st, cfg);
      st.stopSetAt = now;
      acts.push({ type: 'SET_STOP', price: st.stop });
    }
    return acts;
  }

  if (st.phase === 'LOCKED') {
    if (st.side === 'long' ? price <= st.stop : price >= st.stop) {
      acts.push({ type: 'CLOSE', reason: 'stop' });
      return acts;
    }
    if (now - st.stopSetAt >= cfg.stopUpdateMs) {
      const next = lockPrice(st, cfg);
      if (st.side === 'long' ? next > st.stop : next < st.stop) {
        st.stop = next;
        st.stopSetAt = now;
        acts.push({ type: 'SET_STOP', price: next });
      }
    }
  }
  return acts;
}

module.exports = { newState, step, favorable };
