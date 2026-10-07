'use strict';
// Bybit 실주문 봇.
//   BYBIT_ENV = demo(연습모드, 실제 시세·가상 자금) | testnet(기본) | mainnet
//   기본은 드라이런(주문 안 냄). LIVE_ORDERS=1 이면 주문을 냅니다.
//   메인넷은 BYBIT_ENV=mainnet 과 BYBIT_MAINNET_CONFIRM=I-ACCEPT-REAL-MONEY-RISK 가 모두 있어야 합니다.
//   키: BYBIT_API_KEY / BYBIT_API_SECRET (거래 권한만, 출금 권한 끄기, 서브계정 권장)
//   중단: 이 폴더에 STOP 파일을 만들면 대기 트리거를 모두 거두고 종료합니다 (열린 포지션은 그대로).
const fs = require('fs');
const cfg = { ...require('./config') };
// 소액 적용 시 코드 수정 없이 환경변수로 시드/배율만 바꾼다. 예: SEED=200 LEVERAGE=5
if (process.env.SEED) cfg.seed = +process.env.SEED;
if (process.env.LEVERAGE) cfg.leverage = +process.env.LEVERAGE;
const api = require('./lib/bybit-public');
const { Client } = require('./lib/bybit-client');
const { LiveBroker } = require('./lib/live-broker');
const { LiveRunner } = require('./lib/live-sync');

const env = process.env.BYBIT_ENV || 'testnet';
const orders = process.env.LIVE_ORDERS === '1';
const STOP = process.env.STOP_FILE || './STOP';

(async () => {
  api.setEnv(env);
  const client = new Client({ env, key: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET });
  const broker = new LiveBroker(client, cfg, { orders });
  console.log(`env=${env} orders=${orders ? 'ON' : 'OFF(dry-run)'} 레버리지 ${cfg.leverage}x 진입증거금 ${cfg.seed / cfg.entryDivisor} USDT`);
  await broker.init();
  const w = await broker.wallet();
  console.log(`지갑 자산 ${w.equity} / 사용가능 ${w.available} (설정 시드 ${cfg.seed})`);
  if (orders && w.available < cfg.seed) console.log('경고: 사용가능 잔고가 설정 시드보다 적습니다');

  const runner = new LiveRunner({ cfg, broker, api, file: process.env.STATE_FILE || './live-state.json' });
  const quit = async () => { console.log('종료: 대기 트리거 철회'); await runner.shutdown(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);

  for (;;) {
    if (fs.existsSync(STOP)) return quit();
    try { await runner.tick(); } catch (e) { console.error('tick 실패:', e.message); }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
