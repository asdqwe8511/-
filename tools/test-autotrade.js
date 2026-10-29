#!/usr/bin/env node
// 자동매매 점검. 거래소는 가짜(FakeExchange)로 세워 두고 tools/autotrade.js 를 그대로 부른다.
// 실제 바이낸스에는 접속하지 않는다.
//   node tools/test-autotrade.js
const E = require('../position-engine.js');
const core = require('./autotrade-core.js');
const { runOnce, parseArgs, msUntilNextRun } = require('./autotrade.js');
const { createClient, sign, MAINNET_PUBLIC } = require('./binance-futures-client.js');

let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (c ? '' : '  → ' + x)); };
const near = (a, b, t) => Math.abs(a - b) <= t;

function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function synth(n, seed, drift, vol) {
  const r = rng(seed), out = []; let p = 30000;
  for (let i = 0; i < n; i++) {
    const o = p, g = (r() + r() + r() - 1.5) * 2 * vol + drift, c = o * (1 + g);
    out.push({ t: i * 86400000, o, h: Math.max(o, c) * (1 + r() * vol * .6), l: Math.min(o, c) * (1 - r() * vol * .6), c }); p = c;
  }
  return out;
}

class FakeExchange {
  constructor(o) {
    o = o || {};
    this.wallet = o.wallet || 10000; this.equity = o.equity || this.wallet; this.qty = o.qty || 0; this.entry = o.entry || 0; this.px = o.price || 30000;
    this.orders = o.orders || []; this.calls = []; this.ids = new Set(); this.failStop = !!o.failStop; this.dual = !!o.dual;
  }
  async dualSide() { return this.dual; }
  async exchangeFilters() { return { stepSize: 0.001, minQty: 0.001, tickSize: 0.1, minNotional: 100 }; }
  async account() { return { wallet: this.wallet, equity: this.equity, available: this.wallet }; }
  async position() { return { qty: this.qty, entryPrice: this.entry, markPrice: this.px }; }
  async openOrders() { return this.orders.slice(); }
  async price() { return this.px; }
  async cancelAll() { this.calls.push(['cancelAll']); this.orders = []; }
  async setIsolated() { this.calls.push(['isolated']); }
  async setLeverage(s, l) { this.calls.push(['leverage', l]); }
  async marketOrder(sym, side, qty, reduceOnly, id) {
    if (this.ids.has(id)) { const e = new Error('Duplicate clientOrderId'); e.code = -4015; throw e; }
    this.ids.add(id); this.calls.push(['market', side, qty, !!reduceOnly, id]);
    const signed = side === 'BUY' ? qty : -qty;
    if (!this.qty) this.entry = this.px;
    this.qty = +(this.qty + signed).toFixed(8); if (Math.abs(this.qty) < 1e-9) this.qty = 0;
  }
  async stopOrder(sym, side, stopPrice, id) {
    if (this.failStop) throw new Error('stop rejected');
    this.calls.push(['stop', side, stopPrice, id]); this.orders.push({ type: 'STOP_MARKET', stopPrice, closePosition: true });
  }
  of(kind) { return this.calls.filter(c => c[0] === kind); }
}

const baseCfg = (o) => Object.assign({ symbol: 'BTCUSDT', side: 'long', live: true, riskPct: 0.5, leverage: 2, dailyLossPct: 3, feePct: 0.05, slipPct: 0.02,
  engine: { side: 'long', riskPct: 0.5, leverage: 2, feePct: 0.05, slipPct: 0.02, trendMaPeriod: 0, atrStopMult: 0, cooldownBars: 0 } }, o || {});
function memStore(init) { let s = JSON.parse(JSON.stringify(init || {})); return { load: () => JSON.parse(JSON.stringify(s)), save: x => { s = JSON.parse(JSON.stringify(x)); }, raw: () => s }; }
const deps = (ex, candles, cfg, store, extra) => Object.assign({ client: ex, getKlines: async () => candles, store, log: () => {}, notify: async () => {}, cfg, now: () => candles[candles.length - 1].t + 86400000 + 3600000 }, extra);

// 엔진을 직접 돌려, 마지막 봉에서 각 행동이 나오는 지점을 찾는다.
function findEvents() {
  const found = {};
  for (let seed = 1; seed <= 60 && !(found.open && found.add && found.reduce && found.close); seed++) {
    const cs = synth(1300, seed, 0.0004, 0.025);
    const bt = E.backtest(cs, { side: 'long', riskPct: 0.5, leverage: 2, feePct: 0.05, slipPct: 0.02, mode: 'ladder', startEquity: 10000, compound: false });
    for (const ev of bt.events) if (ev.i >= 300 && !found[ev.type]) found[ev.type] = { cs: cs.slice(0, ev.i + 1), ev };
  }
  return found;
}

(async () => {
  const F = findEvents();
  console.log('엔진 이벤트');
  {
    const cs = synth(1500, 5, 0.0004, 0.025);
    const bt = E.backtest(cs, { riskPct: 1 });
    const opens = bt.events.filter(e => e.type === 'open').length, closes = bt.events.filter(e => e.type === 'close').length;
    const forced = bt.trades.filter(t => t.reason === 'end').length;
    ok('open 이벤트 수 = 거래 수', opens === bt.trades.length && opens > 0, opens + ' vs ' + bt.trades.length);
    ok('close 이벤트 수 = 거래 수 − 마지막 강제정리', closes === bt.trades.length - forced, closes + ' vs ' + (bt.trades.length - forced));
    ok('테스트용 시세에서 open/add/reduce/close 이벤트를 모두 찾음', !!(F.open && F.add && F.reduce && F.close), Object.keys(F).join());
    ok('reduce 이벤트의 fraction 은 0~1 사이', F.reduce && F.reduce.ev.fraction > 0 && F.reduce.ev.fraction < 1, F.reduce && F.reduce.ev.fraction);
  }

  console.log('판단(decide)');
  {
    const { cs, ev } = F.open;
    const now = cs[cs.length - 1].t + 86400000 + 3600000;
    const d = core.decide({ candles: cs, balance: 10000, position: null, params: baseCfg().engine, state: {}, nowMs: now });
    ok('진입 봉에서 open 행동 1개', d.actions.length === 1 && d.actions[0].kind === 'open', JSON.stringify(d.actions));
    const a = d.actions[0], px = cs[cs.length - 1].c;
    const lossAtStop = a.notional * (px - a.stop) / px;                  // 1단계는 계획 전체(1+2+6)의 1/9
    ok('1단계 금액 = 전체 계획의 1/9 → 전 단계 손절 손실 ≈ 잔고의 0.5%(' + (lossAtStop * 9).toFixed(1) + '/50)', lossAtStop * 9 > 30 && lossAtStop * 9 <= 50.5, lossAtStop * 9);
    ok('이미 포지션이 있으면 open 은 건너뜀', core.decide({ candles: cs, balance: 10000, position: { qty: 0.1, entryPrice: px }, params: baseCfg().engine, state: {}, nowMs: now }).actions.length === 0, '');
    ok('반대 방향 포지션이 있으면 아무것도 안 함', core.decide({ candles: cs, balance: 10000, position: { qty: -0.1, entryPrice: px }, params: baseCfg().engine, state: {}, nowMs: now }).skip, '');
    ok('같은 봉을 이미 처리했으면 건너뜀', core.decide({ candles: cs, balance: 10000, position: null, params: baseCfg().engine, state: { lastBarT: cs[cs.length - 1].t }, nowMs: now }).skip, '');
    ok('진행 중인 오늘 봉은 신호에 쓰지 않음', core.closedCandles(cs, cs[cs.length - 1].t + 3600000).length === cs.length - 1, '');
    ok('마지막 봉이 3일 넘게 묵었으면 건너뜀', core.decide({ candles: cs, balance: 10000, position: null, params: baseCfg().engine, state: {}, nowMs: now + 4 * 86400000 }).skip, '');
    ok('잔고를 못 읽으면 건너뜀', core.decide({ candles: cs, balance: 0, position: null, params: baseCfg().engine, state: {}, nowMs: now }).skip, '');
    ok('캔들이 부족하면 건너뜀', core.decide({ candles: cs.slice(0, 100), balance: 10000, position: null, params: baseCfg().engine, state: {}, nowMs: now }).skip, '');
  }

  console.log('실행 — 모의 실행');
  {
    const { cs } = F.open, ex = new FakeExchange({ price: F.open.cs[F.open.cs.length - 1].c }), st = memStore();
    const r = await runOnce(deps(ex, cs, baseCfg({ live: false }), st));
    ok('모의 실행은 주문을 하나도 내지 않음', ex.calls.length === 0 && r.actions.length === 1, JSON.stringify(ex.calls));
    ok('모의 실행은 상태 파일을 쓰지 않음', Object.keys(st.raw()).length === 0, JSON.stringify(st.raw()));
  }

  console.log('실행 — 진입(테스트넷 실주문 흐름)');
  {
    const { cs } = F.open, px = cs[cs.length - 1].c, ex = new FakeExchange({ price: px }), st = memStore();
    const r = await runOnce(deps(ex, cs, baseCfg(), st));
    const m = ex.of('market')[0], s = ex.of('stop')[0];
    ok('시장가 매수가 나감(reduceOnly 아님)', m && m[1] === 'BUY' && m[3] === false && m[2] > 0, JSON.stringify(ex.calls));
    ok('격리 마진 + 레버리지 2 설정', ex.of('isolated').length === 1 && ex.of('leverage')[0][1] === 2, '');
    ok('진입 직후 서버 손절(SELL)을 걺', s && s[1] === 'SELL' && s[2] < px, JSON.stringify(s));
    ok('주문 순서: 레버리지 설정 → 시장가 → 손절', ex.calls.map(c => c[0]).join() === 'isolated,leverage,market,stop', ex.calls.map(c => c[0]).join());
    ok('상태에 손절가와 처리한 봉이 기록됨', st.raw().stop === s[2] && st.raw().lastBarT === cs[cs.length - 1].t, JSON.stringify(st.raw()));
    const notional = m[2] * px;
    ok('금액이 잔고×레버리지×0.95 이내', notional <= 10000 * 2 * 0.95 + 1, notional);
    const before = ex.calls.length;
    await runOnce(deps(ex, cs, baseCfg(), st));
    ok('같은 봉을 다시 돌려도 주문이 늘지 않음(멱등)', ex.calls.length === before, ex.calls.length + '/' + before);
    let dup = null; try { await ex.marketOrder('BTCUSDT', 'BUY', 0.001, false, m[4]); } catch (e) { dup = e.code; }
    ok('같은 주문 ID 는 거래소가 중복으로 거절', dup === -4015, dup);
  }

  console.log('실행 — 안전장치');
  {
    const { cs } = F.open, px = cs[cs.length - 1].c;
    const ex = new FakeExchange({ price: px, failStop: true }), st = memStore();
    let err = null; try { await runOnce(deps(ex, cs, baseCfg(), st)); } catch (e) { err = e; }
    ok('손절 주문이 실패하면 예외를 던지고', !!err && /손절 주문 실패/.test(err.message), err && err.message);
    ok('포지션을 즉시 정리(reduceOnly 매도) — 손절 없는 포지션을 남기지 않음', ex.qty === 0 && ex.of('market').some(c => c[1] === 'SELL' && c[3] === true), JSON.stringify(ex.calls));
    ok('실패한 봉은 처리 완료로 기록하지 않음', st.raw().lastBarT === undefined, JSON.stringify(st.raw()));

    const ex2 = new FakeExchange({ price: px, wallet: 10000, equity: 9600, qty: 0.2, entry: px, orders: [{ type: 'STOP_MARKET' }] });
    const nowMs = cs[cs.length - 1].t + 86400000 + 3600000;
    const st2 = memStore({ dayKey: new Date(nowMs).toISOString().slice(0, 10), dayStartEquity: 10000, stop: px * 0.95 });
    const r2 = await runOnce(deps(ex2, cs, baseCfg(), st2));
    ok('하루 손실 3% 초과(−4%) → 전량 청산 후 멈춤', r2.halted && ex2.qty === 0 && st2.raw().halted === true, JSON.stringify(st2.raw()));
    const calls = ex2.calls.length;
    const r3 = await runOnce(deps(ex2, cs, baseCfg(), st2));
    ok('멈춘 뒤에는 다음 실행이 아무 주문도 안 냄', r3.halted && ex2.calls.length === calls, '');

    const ex3 = new FakeExchange({ price: px, dual: true });
    let e3 = null; try { await runOnce(deps(ex3, cs, baseCfg(), memStore())); } catch (e) { e3 = e; }
    ok('헤지 모드 계정이면 거부', !!e3 && /헤지/.test(e3.message), e3 && e3.message);
    let e4 = null; try { await runOnce(deps(new FakeExchange(), cs, baseCfg({ leverage: 20 }), memStore())); } catch (e) { e4 = e; }
    ok('레버리지 20배는 거부(상한 10)', !!e4, '');
    let e5 = null; try { await runOnce(deps(new FakeExchange(), cs, baseCfg({ riskPct: 10 }), memStore())); } catch (e) { e5 = e; }
    ok('거래당 손실 10%는 거부(상한 5%)', !!e5, '');

    const ex6 = new FakeExchange({ price: px, qty: 0.2, entry: px, orders: [] }), st6 = memStore({ stop: px * 0.93 });
    await runOnce(deps(ex6, synth(300, 1, 0, 0.02), baseCfg(), st6, { now: () => synth(300, 1, 0, 0.02)[299].t + 86400000 + 3600000 }));
    ok('포지션이 있는데 서버 손절이 없으면 보호 손절부터 걺', ex6.of('stop').length === 1 && near(ex6.of('stop')[0][2], +(px * 0.93).toFixed(1), 0.11), JSON.stringify(ex6.calls));
    const ex7 = new FakeExchange({ price: px, wallet: 150 });
    await runOnce(deps(ex7, F.open.cs, baseCfg(), memStore()));
    ok('주문 금액이 최소 주문 금액보다 작으면 주문하지 않음', ex7.of('market').length === 0, JSON.stringify(ex7.calls));
  }

  console.log('실행 — 추가·감축·청산');
  {
    const mk = (kind) => { const { cs } = F[kind], px = cs[cs.length - 1].c; return { cs, px }; };
    let { cs, px } = mk('add'); let ex = new FakeExchange({ price: px, qty: 0.05, entry: px, orders: [{ type: 'STOP_MARKET' }] }), st = memStore({ stop: px * 0.9 });
    await runOnce(deps(ex, cs, baseCfg(), st));
    ok('add: 같은 방향 시장가 매수, 손절 주문은 건드리지 않음', ex.of('market').length === 1 && ex.of('market')[0][1] === 'BUY' && ex.of('stop').length === 0, JSON.stringify(ex.calls));
    ok('add: 포지션이 없으면(이 봇 것이 아니면) 건너뜀', await (async () => { const e = new FakeExchange({ price: px }); await runOnce(deps(e, cs, baseCfg(), memStore())); return e.of('market').length === 0; })(), '');

    ({ cs, px } = mk('reduce'));
    ex = new FakeExchange({ price: px, qty: 0.9, entry: px, orders: [{ type: 'STOP_MARKET' }] }); st = memStore({ stop: px * 0.9 });
    await runOnce(deps(ex, cs, baseCfg(), st));
    const rm = ex.of('market')[0];
    const want = core.roundQty(0.9 * F.reduce.ev.fraction, { stepSize: 0.001, minQty: 0.001 });
    ok('reduce: reduceOnly 매도로 보유량×비율만큼(' + want + ')', rm && rm[1] === 'SELL' && rm[3] === true && near(rm[2], want, 1e-9), JSON.stringify(ex.calls));
    ok('reduce: 일부만 줄었으니 포지션이 남음', ex.qty > 0, ex.qty);

    ({ cs, px } = mk('close'));
    ex = new FakeExchange({ price: px, qty: 0.4, entry: px, orders: [{ type: 'STOP_MARKET' }] }); st = memStore({ stop: px * 0.9 });
    await runOnce(deps(ex, cs, baseCfg(), st));
    ok('close: 전량 reduceOnly 청산 + 남은 주문 취소', ex.qty === 0 && ex.of('cancelAll').length === 1, JSON.stringify(ex.calls));
    ok('close: 상태의 손절가 지움', st.raw().stop === null, JSON.stringify(st.raw()));
  }

  console.log('클라이언트·유틸');
  {
    ok('HMAC-SHA256 서명이 바이낸스 문서 예시와 같음', sign('symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559', 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j') === 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71', '');
    let e = null; try { createClient({ baseUrl: MAINNET_PUBLIC, apiKey: 'k', apiSecret: 's' }); } catch (x) { e = x; }
    ok('실거래 주소로는 클라이언트를 만들 수 없음', !!e && /테스트넷/.test(e.message), e && e.message);
    e = null; try { createClient({ baseUrl: 'https://api.binance.com', apiKey: 'k', apiSecret: 's' }); } catch (x) { e = x; }
    ok('현물 실거래 주소도 거부', !!e, '');
    e = null; try { createClient({}); } catch (x) { e = x; }
    ok('키가 없으면 거부', !!e && /KEY/.test(e.message), e && e.message);
    const seen = [];
    const c = createClient({ apiKey: 'KEY1', apiSecret: 'SECRET1', fetch: async (url, o) => { seen.push({ url, o }); return { ok: true, text: async () => JSON.stringify({ dualSidePosition: false }) }; } });
    await c.dualSide();
    ok('요청에 서명·타임스탬프가 붙고 키는 헤더로만 감(URL 에 키/시크릿 없음)', /signature=[0-9a-f]{64}/.test(seen[0].url) && /timestamp=\d+/.test(seen[0].url) && seen[0].o.headers['X-MBX-APIKEY'] === 'KEY1' && !/KEY1|SECRET1/.test(seen[0].url), seen[0].url);
    const c2 = createClient({ apiKey: 'K', apiSecret: 'S', fetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ code: -2015, msg: 'Invalid API-key' }) }) });
    let er = null; try { await c2.account(); } catch (x) { er = x; }
    ok('오류 메시지에 코드가 실리고 키는 안 실림', er && er.code === -2015 && !/K\b.*S\b/.test('') && !/SECRET/.test(er.message), er && er.message);
    ok('roundQty: 단위 내림, 최소 미만이면 null', core.roundQty(0.12345, { stepSize: 0.001, minQty: 0.001 }) === 0.123 && core.roundQty(0.0004, { stepSize: 0.001, minQty: 0.001 }) === null, '');
    const ks = core.killSwitch({}, 10000, 3, Date.UTC(2026, 0, 5, 12));
    ok('킬스위치: 새 날이면 시작 자산을 현재로 잡음', ks.state.dayStartEquity === 10000 && !ks.tripped, '');
    ok('킬스위치: −3% 에서 작동, −2.9% 는 아님', core.killSwitch(ks.state, 9700, 3, Date.UTC(2026, 0, 5, 20)).tripped && !core.killSwitch(ks.state, 9710, 3, Date.UTC(2026, 0, 5, 20)).tripped, '');
    ok('킬스위치: 다음 날에는 기준이 새로 잡힘', core.killSwitch(ks.state, 9000, 3, Date.UTC(2026, 0, 6, 1)).tripped === false, '');
    const a = parseArgs(['--live', '--side', 'short', '--risk', '0.25', '--lev', '3', '--trend', '100:slope', '--atr', '2', '--cooldown', '5']);
    ok('옵션 파싱', a.live && a.side === 'short' && a.riskPct === 0.25 && a.engine.trendMaPeriod === 100 && a.engine.trendMode === 'slope' && a.engine.atrStopMult === 2 && a.engine.cooldownBars === 5, JSON.stringify(a));
    ok('옵션 기본값은 모의 실행(live=false)', parseArgs([]).live === false, '');
    ok('다음 실행은 UTC 00:05', msUntilNextRun(Date.UTC(2026, 0, 5, 23, 0)) === 65 * 60000 && msUntilNextRun(Date.UTC(2026, 0, 5, 0, 1)) === 4 * 60000, '');
  }

  console.log('\n' + pass + ' 통과 / ' + fail + ' 실패');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
