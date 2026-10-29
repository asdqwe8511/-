#!/usr/bin/env node
// 1:2:6 분할매매 자동매매 — 바이낸스 선물 "테스트넷" 전용.
//
//   node tools/autotrade.js                  # 모의 실행(주문을 내지 않고 무엇을 할지만 출력)
//   node tools/autotrade.js --live           # 테스트넷에 실제로 주문
//   node tools/autotrade.js --live --loop    # 매일 UTC 00:05 에 한 번씩 계속
//   node tools/autotrade.js --reset-halt     # 킬스위치가 멈춘 뒤 다시 켜기
//
// 주요 옵션: --symbol BTCUSDT  --side long|short  --risk 0.5(거래당 손실 %)  --lev 2
//            --daily-loss 3(하루 손실 한도 %)  --trend 100:slope|200:above  --atr 2  --cooldown 5
//
// 키는 .env 또는 환경변수 BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET. 출금 권한이 없는
// 테스트넷 키만 쓰세요. 이 스크립트는 테스트넷 주소 외에는 접속하지 않는다(시세 읽기 제외).
//
// 이 파일은 안전장치 때문에 일부러 보수적이다.
//   · 기본은 모의 실행. --live 를 줘야 주문이 나간다.
//   · 진입 직후 서버에 손절(STOP_MARKET, closePosition)을 건다. 못 걸면 바로 청산한다.
//   · 하루 손실 한도에 닿으면 전부 정리하고 멈춘다(--reset-halt 전까지 재개 안 함).
//   · 주문 ID 가 봉·단계마다 정해져 있어, 같은 봉을 두 번 돌려도 중복 주문이 거절된다.
//   · 청산가가 손절가보다 가까우면 진입하지 않는다.
const fs = require('fs');
const path = require('path');
const E = require('../position-engine.js');
const core = require('./autotrade-core.js');
const { createClient, publicKlines } = require('./binance-futures-client.js');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '.autotrade');
const HARD_MAX_LEVERAGE = 10;
const FALLBACK_STOP_PCT = 15;

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
}

const fileStore = {
  load() { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8')); } catch (e) { return {}; } },
  save(s) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(s, null, 2)); }
};

function fileLog(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(path.join(DIR, 'autotrade.log'), line + '\n'); } catch (e) {}
}

async function telegram(msg) {
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) return;
  try { await fetch('https://api.telegram.org/bot' + t + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c, text: '[autotrade] ' + msg }) }); } catch (e) {}
}

function roundTick(price, tick) {
  const dec = (String(tick).split('.')[1] || '').length;
  return +(Math.round(price / tick) * tick).toFixed(dec);
}

/** 한 번 실행. deps 를 통째로 주입받아 거래소 없이도 테스트할 수 있다. */
async function runOnce(deps) {
  const { client, getKlines, store, log, notify, cfg } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const sym = cfg.symbol, live = !!cfg.live;
  const dir = cfg.side === 'short' ? -1 : 1;
  const tag = live ? '' : '[모의] ';
  const result = { actions: [], executed: [], notes: [], halted: false };
  const note = m => { result.notes.push(m); log(tag + m); };

  if (!(cfg.leverage >= 1 && cfg.leverage <= HARD_MAX_LEVERAGE)) throw new Error('레버리지는 1~' + HARD_MAX_LEVERAGE + ' 사이여야 합니다.');
  if (!(cfg.riskPct > 0 && cfg.riskPct <= 5)) throw new Error('거래당 손실 %는 0 초과 5 이하만 허용합니다.');
  let state = store.load();
  if (state.halted) { note('킬스위치로 멈춘 상태입니다(' + state.haltReason + '). 확인 후 --reset-halt 로 풀어 주세요.'); result.halted = true; return result; }

  if (await client.dualSide()) throw new Error('헤지 모드(양방향) 계정입니다. 단방향 모드로 바꾼 뒤 다시 실행하세요.');
  const filters = await client.exchangeFilters(sym);
  const acct = await client.account();
  let pos = await client.position(sym);
  const orders = await client.openOrders(sym);
  const hasStop = orders.some(o => o.type === 'STOP_MARKET');
  const closeAll = async (reason) => {
    const q = Math.abs(pos.qty); if (!q) return;
    if (live) { await client.marketOrder(sym, pos.qty > 0 ? 'SELL' : 'BUY', q, true, 'X' + now.toString(36) + reason.slice(0, 6)); await client.cancelAll(sym); }
    note('전량 정리(' + reason + '): ' + q + ' ' + sym);
    pos = { qty: 0, entryPrice: 0, markPrice: 0 };
  };

  // 1) 킬스위치
  const ks = core.killSwitch(state, acct.equity, cfg.dailyLossPct, now);
  state = ks.state;
  if (ks.tripped) {
    await closeAll('daily-loss');
    state.halted = true; state.haltReason = '하루 손실 ' + ks.lossPct.toFixed(2) + '% (한도 ' + cfg.dailyLossPct + '%)';
    if (live) store.save(state);
    await notify('킬스위치 작동: ' + state.haltReason);
    note('킬스위치 작동: ' + state.haltReason); result.halted = true; return result;
  }

  // 2) 포지션은 있는데 서버 손절이 없으면 보호 주문부터 건다
  if (pos.qty !== 0 && !hasStop) {
    const stop = state.stop || pos.entryPrice * (1 - dir * FALLBACK_STOP_PCT / 100);
    const px = roundTick(stop, filters.tickSize);
    note('서버 손절이 없어 ' + px + ' 에 보호 손절을 겁니다' + (state.stop ? '' : '(기록이 없어 진입가 ∓' + FALLBACK_STOP_PCT + '%)') + '.');
    if (live) await client.stopOrder(sym, pos.qty > 0 ? 'SELL' : 'BUY', px, 'S' + now.toString(36));
    state.stop = px;
    await notify('보호 손절 보강: ' + px);
  }

  // 3) 판단
  const candles = await getKlines(sym, '1d', 1000);
  const dec = core.decide({ candles, balance: acct.wallet, position: pos.qty ? pos : null, state, nowMs: now, params: cfg.engine });
  dec.notes.forEach(note);
  result.actions = dec.actions;
  if (dec.skip) { return result; }
  const barDate = new Date(dec.barT).toISOString().slice(0, 10).replace(/-/g, '');

  // 4) 실행
  for (const a of dec.actions) {
    const cid = ('L' + barDate + a.tag).slice(0, 36);
    const entrySide = dir > 0 ? 'BUY' : 'SELL', exitSide = dir > 0 ? 'SELL' : 'BUY';
    if (a.kind === 'open' || a.kind === 'add') {
      const price = await client.price(sym);
      const lev = cfg.leverage;
      let notional = Math.min(a.notional, acct.wallet * lev * 0.95);
      if (a.kind === 'open') {
        const stop = roundTick(a.stop, filters.tickSize);
        if (!(dir > 0 ? stop < price * 0.999 : stop > price * 1.001)) { note('손절가(' + stop + ')가 현재가(' + price + ')에 너무 가깝거나 반대편입니다. 진입 취소.'); continue; }
        const chk = E.sizePosition({ account: acct.wallet, riskPct: cfg.riskPct, entry: price, stop, side: cfg.side, leverage: lev, feePct: cfg.feePct, slipPct: cfg.slipPct });
        if (chk.ok && chk.liqBeforeStop) { note('청산가가 손절가보다 가까워 진입하지 않습니다(레버리지를 낮추세요).'); continue; }
        a.stopPx = stop;
      }
      const qty = core.roundQty(notional / price, filters);
      if (qty === null || qty * price < filters.minNotional) { note('주문 금액이 너무 작습니다(' + notional.toFixed(2) + ' USDT, 최소 ' + filters.minNotional + '). ' + a.kind + ' 건너뜀.'); continue; }
      note(a.kind + ' ' + cfg.side + ' ' + qty + ' ' + sym + ' ≈ ' + (qty * price).toFixed(2) + ' USDT' + (a.stopPx ? ', 손절 ' + a.stopPx : '') + ' [' + cid + ']');
      if (!live) continue;
      if (a.kind === 'open') { await client.setIsolated(sym); await client.setLeverage(sym, lev); }
      await client.marketOrder(sym, entrySide, qty, false, cid);
      result.executed.push(cid);
      if (a.kind === 'open') {
        try { await client.stopOrder(sym, exitSide, a.stopPx, 'S' + cid.slice(1)); state.stop = a.stopPx; }
        catch (e) {                                              // 손절 없는 포지션은 두지 않는다
          pos = await client.position(sym);
          await closeAll('stop-failed');
          await notify('손절 주문 실패로 즉시 청산: ' + e.message);
          throw new Error('손절 주문 실패 — 포지션을 즉시 정리했습니다: ' + e.message);
        }
      }
      await notify(a.kind + ' ' + cfg.side + ' ' + qty + ' ' + sym + ' @~' + price);
    } else if (a.kind === 'reduce') {
      const qty = core.roundQty(Math.abs(pos.qty) * a.fraction, filters);
      if (qty === null || qty >= Math.abs(pos.qty)) { note('감축 수량이 단위보다 작거나 전량입니다. 건너뜀(다음 신호에서 정리).'); continue; }
      note('reduce ' + qty + ' ' + sym + ' (' + a.reason + ') [' + cid + ']');
      if (!live) continue;
      await client.marketOrder(sym, exitSide, qty, true, cid);
      result.executed.push(cid);
      await notify('감축 ' + qty + ' ' + sym + ' (' + a.reason + ')');
    } else if (a.kind === 'close') {
      note('close all (' + a.reason + ') [' + cid + ']');
      if (live) { await client.marketOrder(sym, exitSide, Math.abs(pos.qty), true, cid); await client.cancelAll(sym); result.executed.push(cid); state.stop = null; await notify('전량 청산 ' + sym + ' (' + a.reason + ')'); }
      pos = { qty: 0, entryPrice: 0, markPrice: 0 };
    }
  }

  state.lastBarT = dec.barT;
  if (live) store.save(state);
  return result;
}

function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const has = k => argv.includes('--' + k);
  const [maP, maMode] = String(get('trend', '0')).split(':');
  const cfg = {
    symbol: get('symbol', 'BTCUSDT'), side: get('side', 'long'), live: has('live'), loop: has('loop'), resetHalt: has('reset-halt'),
    riskPct: +get('risk', 0.5), leverage: +get('lev', 2), dailyLossPct: +get('daily-loss', 3),
    feePct: +get('fee', 0.05), slipPct: +get('slip', 0.02)
  };
  cfg.engine = { side: cfg.side, riskPct: cfg.riskPct, leverage: cfg.leverage, feePct: cfg.feePct, slipPct: cfg.slipPct,
    trendMaPeriod: +maP || 0, trendMode: maMode || 'above', atrStopMult: +get('atr', 0), cooldownBars: +get('cooldown', 0) };
  return cfg;
}

function msUntilNextRun(now) {
  const d = new Date(now); const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 5, 0);
  return (next > now ? next : next + 86400000) - now;
}

async function main() {
  loadDotEnv();
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.resetHalt) { const s = fileStore.load(); delete s.halted; delete s.haltReason; fileStore.save(s); console.log('킬스위치를 풀었습니다.'); return; }
  const client = createClient({ apiKey: process.env.BINANCE_TESTNET_API_KEY, apiSecret: process.env.BINANCE_TESTNET_API_SECRET });
  await client.syncTime();
  fileLog('시작: ' + (cfg.live ? '테스트넷 실주문' : '모의 실행(주문 없음, --live 로 켬)') + ' ' + cfg.symbol + ' ' + cfg.side + ' 위험 ' + cfg.riskPct + '% 레버리지 ' + cfg.leverage + ' 하루손실한도 ' + cfg.dailyLossPct + '%');
  const deps = { client, getKlines: (s, i, l) => publicKlines(s, i, l), store: fileStore, log: fileLog, notify: telegram, cfg };
  for (;;) {
    try { await runOnce(deps); }
    catch (e) { fileLog('오류: ' + e.message); await telegram('오류: ' + e.message); if (!cfg.loop) process.exit(1); }
    if (!cfg.loop) return;
    const wait = msUntilNextRun(Date.now());
    fileLog('다음 실행까지 ' + Math.round(wait / 60000) + '분');
    await new Promise(r => setTimeout(r, wait));
  }
}

if (require.main === module) main().catch(e => { console.error('실패: ' + e.message); process.exit(1); });

module.exports = { runOnce, parseArgs, msUntilNextRun, roundTick };
