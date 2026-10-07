'use strict';
// 코인 하나의 상태 기계. 거래소 호출 없이 "무엇을 해야 하는지"만 돌려준다.
//  WATCH : 지지선/저항선 트리거 대기
//  OPEN  : 첫 진입. 스탑 없음, 익절 or 청산까지 방치 (규칙5)
//  HALF  : ±10% 방향 적중 → 50% 익절 완료, 남은 물량에 스탑 (규칙2), 하루 1회 상향 수정 (규칙3)

const newState = () => ({ phase: 'WATCH', cooldownUntil: 0 });

function favorable(st, price) {
  return st.side === 'long' ? (price - st.entry) / st.entry : (st.entry - price) / st.entry;
}

// levels = { support, resistance } (오늘 기준). 반환: 액션 배열
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

  if (st.phase === 'OPEN') {
    if (favorable(st, price) >= cfg.takeProfitMove) {
      st.phase = 'HALF';
      st.stop = st.entry;                 // 본전 스탑에서 시작
      st.stopSetAt = now;
      acts.push({ type: 'REDUCE', fraction: cfg.takeProfitFraction, reason: 'take-profit' });
      acts.push({ type: 'SET_STOP', price: st.stop });
    }
    return acts;
  }

  if (st.phase === 'HALF') {
    const hit = st.side === 'long' ? price <= st.stop : price >= st.stop;
    if (hit) { acts.push({ type: 'CLOSE', reason: 'stop' }); return acts; }
    if (now - st.stopSetAt >= cfg.stopUpdateMs && levels) {
      // 현재가 뒤쪽의 가장 강한 선으로만, 유리한 방향으로만 이동
      const lv = st.side === 'long' ? levels.support : levels.resistance;
      if (lv && (st.side === 'long' ? lv.price > st.stop : lv.price < st.stop)) {
        st.stop = lv.price;
        st.stopSetAt = now;
        acts.push({ type: 'SET_STOP', price: st.stop });
      }
    }
  }
  return acts;
}

module.exports = { newState, step, favorable };
