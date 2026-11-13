# Fibo Alert — Binance Futures 피보나치 역산 분석 · Discord 알림

BTCUSDT 무기한 선물의 **공개 시장 데이터**(API 키 불필요)로 15m/1h(/4h) 확정봉을 분석하고,
조건이 완성되면 Discord Webhook 으로 알림만 보냅니다. **주문·자동매매·계좌 접근은 없습니다.**
알림 속 포지션은 모두 *가상 포지션*입니다.

> 상태: 구현 완료 · **실시장 검증 미완료**. 이 샌드박스에는 Binance 접속이 막혀 있어 합성 데이터
> 테스트(`pytest`)만 통과시켰습니다. 실제 데이터로 `backtest`/`verify` 를 돌려 보기 전에는
> 검증된 시스템이라고 말할 수 없고, 실거래에 쓰면 안 됩니다.

## 실행

```bash
pip install -r requirements.txt
python -m pytest -q                         # 테스트
python -m fibo_alert backfill               # 과거 봉 수집(REST)
export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
python -m fibo_alert test-webhook           # 연결 확인
python -m fibo_alert run                    # 상시 실행(WebSocket)
python -m fibo_alert backtest               # 저장된 봉으로 리플레이 리포트(가상 성과)
python -m fibo_alert verify                 # 라이브 이력 ↔ 리플레이 일치 검증
python -m fibo_alert status
python -m fibo_alert import-vision --dir <zip폴더>   # data.binance.vision 월별 klines zip 적재(지역 제한으로 REST 가 막힌 환경용)
```

Docker: `.env` 에 `DISCORD_WEBHOOK_URL=` 를 넣고 `docker compose up -d`. `data/` 볼륨에 SQLite 가 남습니다.

## 구조

| 파일 | 역할 |
|---|---|
| `binance.py` | REST 봉 수집(속도제한·Retry-After·확정봉만), WebSocket 메시지 파싱 |
| `live.py` | WS 자동 재연결, 누락 봉 REST 복구, 연결 장애 운영 알림, 순차 step |
| `indicators.py` `trend.py` | EMA200·ATR·피벗(좌우 5봉 확정), 방향 판정(LONG/SHORT/WAIT) |
| `fib.py` | 피보나치 역산 `0=(피벗-비율×시작)/(1-비율)`, 군집 피팅, 자동/수동 시작점 |
| `engine.py` | 상태 머신·패턴 A/B·SL·가상 포지션·후행 SL |
| `risk.py` | 손익비·수수료·슬리피지·레버리지 경고 |
| `store.py` | SQLite: 봉, 동결 피팅, 신호, 전이 이력, 알림 outbox |
| `notifier.py` `messages.py` | Discord 전송(429 대기·제한 재시도·URL 비노출), 메시지 |
| `replay.py` `report.py` | 리플레이, 라이브 일치 검증, 백테스트 지표 |

## 핵심 규칙이 코드에서 지켜지는 방식

- **확정봉만**: 종료시각 ≤ step 시각인 봉만 로드. 최신 봉이 없거나 구간에 빈 봉이 있으면
  `DATA_ERROR` 로 *멈추고* 재시도(관망으로 위장하지 않음, `engine_status` 와 운영 알림).
- **봉 식별**: UTC 봉 종료시각(`open+tf`). 알림 중복 키 = `신호키|종류[|봉]` (SQLite UNIQUE) → 재시작 후에도 중복 없음.
- **예측 고정**: 피팅은 `fits.frozen_json` 에 생성 시점 그대로 저장되고 DB 트리거가 수정을 막음.
  새 파동(시작점 변경·무효화·목표 도달·만료)이면 `version+1` 로 새로 생성.
- **롱=숏 거울**: 롱은 가격 부호를 뒤집어 같은 코드로 처리(테스트로 대칭 확인).
- **상태 머신**: `WAITING→WATCHING→BREAKOUT_CONFIRMED→RETEST_PENDING→ENTRY_CANDIDATE→TARGET_REACHED→TRAILING→CLOSED`
  + `INVALIDATED`/`TIMEOUT`. 허용 전이표 밖은 예외. 패턴 A 는 BREAKOUT_CONFIRMED 를 건너뛰고
  RETEST_PENDING 을 "더블탑 형성, 넥라인 이탈 대기"로 씀. `DATA_ERROR` 는 신호가 아니라 엔진 단위로 관리.
- **최소 손익비 1:3 미만**이면 진입 알림 없음(전이 이력에 `rr_below_min` 기록).
- **알림 전송**: outbox 방식, at-least-once(전송 성공~DB 기록 사이 크래시 시 드물게 1회 중복 가능).
  늦게 처리된 오래된 봉의 알림은 `suppressed_stale` 로 보내지 않음.

## 구현 시 내린 해석(확인 필요)

1. 피팅은 *생성 후 동결*: 새 피벗이 생겨도 기존 목표는 갱신하지 않음(규칙 9번 해석).
2. 자동 시작점이 여러 개가 비슷한 점수로 서로 다른 목표를 가리키면 **피팅하지 않음**(보수적).
3. 진입 후보가 = 확정 신호 봉의 종가. SL = 리테스트(반등) 고점 ± 0.25 ATR. 같은 봉에서 목표·SL 동시 터치면 SL 우선.
4. 한 사이드에 가상 포지션이 열려 있으면 다른 신호는 조용히 정리(중복 진입 방지).
5. 손익비 하한은 비용 반영 전 기준으로 판정, 비용 반영 값은 메시지에 함께 표시.
6. 패턴 B 의 "3봉 연속 종가"는 돌파봉 포함 3봉 종가가 모두 레벨 위. 그 전에 레벨 아래로 마감하면 돌파 시도 폐기.
7. 신호 키는 `피팅버전|패턴|레벨` 당 1회(같은 레벨 재시도는 새 피팅 버전에서만).
8. 4h 필터는 기본 꺼짐(`trend.use_4h_filter`). 켜려면 4h 봉이 400개 이상 필요(`history_bars`).

## 아직 안 된 것 / 한계

- 실제 Binance 연결(WS/REST), Discord 실전송은 이 환경에서 시험하지 못함.
- 기본 임계값(ATR 0.35, 몸통 70%, 이격 한도 등)은 전부 검증 전 값.
- 백테스트 리포트의 `random_baseline` 은 표본이 작으면 의미 없음. 라이브 신호와 섞지 않으며
  `source='replay'` 로만 집계.
- 청산가는 계산하지 않음(계좌 정보 없음). 레버리지 경고는 근사.
