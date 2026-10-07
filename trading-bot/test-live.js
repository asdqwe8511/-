'use strict';
const assert = require('assert');
const crypto = require('crypto');
const cfg = { ...require('./config'), maxOpen: 2 };
const { Client } = require('./lib/bybit-client');
const { LiveBroker, floorStep, nearStep, dec } = require('./lib/live-broker');
const { LiveRunner } = require('./lib/live-sync');

(async () => {
  // 1) 서명: timestamp + key + recvWindow + (쿼리 | 본문)
  {
    const seen = [];
    const c = new Client({ env: 'testnet', key: 'K', secret: 'S', minGapMs: 0, fetchImpl: async (url, o) => { seen.push({ url, o }); return { status: 200, json: async () => ({ retCode: 0, result: { list: [] } }) }; } });
    await c.get('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    await c.post('/v5/order/create', { a: 1 });
    for (const { url, o } of seen) {
      const h = o.headers, p = o.method === 'GET' ? url.split('?')[1] : o.body;
      const want = crypto.createHmac('sha256', 'S').update(h['X-BAPI-TIMESTAMP'] + 'K' + '5000' + p).digest('hex');
      assert.strictEqual(h['X-BAPI-SIGN'], want);
    }
    assert.throws(() => new Client({ env: 'mainnet', key: 'K', secret: 'S' }), /MAINNET_CONFIRM/);
  }

  // 2) 수량/가격 반올림
  assert.strictEqual(dec('0.001'), 3); assert.strictEqual(dec('1'), 0); assert.strictEqual(dec('1e-7'), 7);
  assert.strictEqual(floorStep(0.0299, 0.001), 0.029); assert.strictEqual(nearStep(100.26, 0.1), 100.3);
  {
    const b = new LiveBroker(null, { ...cfg, leverage: 5 });
    b.inst.set('BTCUSDT', { tick: 0.1, step: 0.001, minQty: 0.001, maxMkt: 100, minNotional: 5, maxLev: 100 });
    b.inst.set('LOWUSDT', { tick: 0.1, step: 1, minQty: 1, maxMkt: 100, minNotional: 5, maxLev: 3 });
    assert.strictEqual(b.qtyFor('BTCUSDT', 50000, 1000), '0.100');       // 1000*5/50000
    assert.strictEqual(b.qtyFor('BTCUSDT', 50000, 1), null);             // 최소수량 미달
    assert(b.tradable('BTCUSDT') && !b.tradable('LOWUSDT'), '최대 레버리지 < 설정 레버리지면 제외');
    assert.strictEqual(b.fmtPrice('BTCUSDT', 100.26), '100.3');
  }

  // 3) 러너: 가짜 거래소로 트리거 → 진입 → 스탑 → 종료 흐름
  const fx = { pos: new Map(), trig: [], calls: [], price: { A: 110, B: 110, C: 110 }, failStop: false, id: 0 };
  const broker = {
    tradable: () => true, roundPrice: (s, p) => p,
    positions: async () => new Map(fx.pos),
    triggers: async () => fx.trig.slice(),
    placeTrigger: async (s, side, price) => { const id = `sb-${fx.id++}`; fx.trig.push({ symbol: s, side, price, id }); fx.calls.push(['place', s, side]); return id; },
    cancel: async (s, id) => { fx.trig = fx.trig.filter((t) => t.id !== id); fx.calls.push(['cancel', s, id]); },
    setStop: async (s, p) => { if (fx.failStop) throw new Error('rejected'); fx.calls.push(['stop', s, p]); },
    closeMarket: async (s) => { fx.calls.push(['close', s]); },
  };
  let t = 10 * 86400e3;
  const api = { tickers: async () => Object.entries(fx.price).map(([symbol, price]) => ({ symbol, price, turnover: 1e9 })) };
  const r = new LiveRunner({ cfg, broker, api, now: () => t, log: () => {}, computeLevels: async () => ({ support: { price: 100 }, resistance: { price: 120 } }) });
  const n = (k, s) => fx.calls.filter((c) => c[0] === k && (!s || c[1] === s)).length;

  await r.tick();
  assert.strictEqual(fx.trig.length, 6, '코인 3개 × (롱1+숏1)');
  await r.tick();
  assert.strictEqual(fx.trig.length, 6); assert.strictEqual(n('place'), 6, '재순회에서 중복 주문 없음');

  // A 롱 체결 → A 트리거 취소, 나머지 유지
  fx.price.A = 100; fx.pos.set('A', { side: 'long', size: '1', avgPrice: 100, stopLoss: 0 });
  fx.trig = fx.trig.filter((x) => !(x.symbol === 'A' && x.side === 'long'));   // 체결된 주문은 목록에서 사라짐
  await r.tick();
  assert.strictEqual(r.st('A').phase, 'OPEN');
  assert(!fx.trig.some((x) => x.symbol === 'A'), 'A 의 남은 숏 트리거도 취소');
  assert.strictEqual(fx.trig.length, 4);
  assert.strictEqual(n('stop'), 0, '첫 진입은 스탑 없음');

  // +10% → 스탑(이익 50% = +5%). 거래소가 거절하면 다음 순회에 재시도
  fx.price.A = 110; fx.failStop = true; await r.tick();
  assert.strictEqual(n('stop'), 0); assert(Math.abs(r.st('A').stop - 105) < 1e-9);
  fx.failStop = false; await r.tick();
  assert.strictEqual(n('stop', 'A'), 1); await r.tick(); assert.strictEqual(n('stop', 'A'), 1, '같은 스탑은 다시 안 보냄');

  // 동시 포지션 상한(2) 도달 → 남은 대기 트리거 전부 철회
  fx.pos.set('B', { side: 'short', size: '1', avgPrice: 120, stopLoss: 0 });
  await r.tick();
  assert.strictEqual(fx.trig.length, 0, '상한이면 트리거 0');

  // A 스탑 체결 → 쿨다운, 그동안 A 트리거 없음
  fx.pos.delete('A'); t += 3600e3; await r.tick();
  assert.strictEqual(r.st('A').phase, 'WATCH'); assert(r.st('A').cooldownUntil > t);
  fx.pos.delete('B'); await r.tick();
  assert(!fx.trig.some((x) => x.symbol === 'A') && fx.trig.some((x) => x.symbol === 'C'), '쿨다운 코인 제외, 나머지는 다시 걸림');

  // 종료: 트리거만 거둔다
  await r.shutdown(); assert.strictEqual(fx.trig.length, 0);
  console.log('live adapter tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
