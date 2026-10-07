'use strict';
// 모든 규칙 숫자는 여기 한 곳에서만 바꿉니다.
module.exports = {
  seed: 10000,            // 전체 시드(USDT). 첫 진입 증거금 = seed / entryDivisor
  entryDivisor: 10,       // 규칙4: 첫 진입은 시드의 1/10, 격리 마진
  leverage: 3,            // 격리 레버리지. 청산가는 진입가에서 약 (1/leverage) 떨어진 곳
  maxOpen: 10,            // 동시 포지션 상한. 1/10씩이라 10개면 시드를 전부 씀
  takeProfitMove: 0.10,   // 규칙2: 진입가 대비 ±10% 방향이 맞으면
  takeProfitFraction: 0.5, //        포지션 50% 익절하고 남은 물량에 스탑로스
  stopUpdateMs: 24 * 3600e3, // 규칙3: 스탑 수정은 1일 1회
  cooldownMs: 24 * 3600e3,   // 포지션 종료 뒤 같은 코인 재진입 대기
  // 지지/저항 탐색(일봉)
  levels: { pivotWing: 3, clusterTol: 0.01, minGap: 0.01, maxDist: 0.20, lookback: 180 },
  // 모의 체결
  fee: 0.00055,           // 테이커 수수료(편도)
  mmr: 0.005,             // 유지증거금률(청산가 계산용 근사)
  slippage: 0.0005,
};
