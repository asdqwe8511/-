#!/usr/bin/env node
// 전략 엔진 점검.
//   node trading/test-strategy.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeMarket, loadCsvMarket } = require('./market');
const { runBacktest, metrics, trendSeries, ema, DEFAULTS } = require('./strategy');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : '  → ' + detail));
};
const many = (n, opts = {}, cfg = {}) => {
  const out = [];
  for (let s = 1; s <= n; s++) out.push(metrics(runBacktest(makeMarket({ seed: s, days: 141, ...opts }), cfg)));
  return out;
};
const ruinRate = (ms) => ms.filter((m) => m.ruined).length / ms.length;

console.log('시장 데이터');
{
  const m = makeMarket({ seed: 11, days: 120 });
  const bad = [];
  for (const s of m.symbols) for (const b of m.bars[s]) {
    if (!(b.h >= Math.max(b.o, b.c) - 1e-9 && b.l <= Math.min(b.o, b.c) + 1e-9 && b.l > 0)) bad.push(b);
  }
  ok('봉의 고가/저가가 시가·종가를 감싼다', bad.length === 0, bad.length + '개 깨짐');
  ok('종목 수와 일수가 맞는다', m.symbols.length === 8 && m.bars[m.symbols[0]].length === 120, m.symbols.length);
  const a = makeMarket({ seed: 11, days: 120 }), b = makeMarket({ seed: 12, days: 120 });
  ok('같은 씨앗이면 같은 시장', JSON.stringify(a.bars) === JSON.stringify(m.bars), '다름');
  ok('다른 씨앗이면 다른 시장', JSON.stringify(b.bars) !== JSON.stringify(m.bars), '같음');
  const f = m.funding[m.symbols[0]];
  ok('펀딩비가 범위 안에 있다', f.every((x) => Math.abs(x) <= 0.0025 + 1e-12), Math.max(...f.map(Math.abs)));
}

console.log('\n추세 판정');
{
  const cfg = { ...DEFAULTS };
  const up = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.02, i));
  const dn = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(0.98, i));
  const flat = Array.from({ length: 80 }, () => 100);
  ok('오르는 값에는 상승 신호', trendSeries(up, cfg)[79] === 1, trendSeries(up, cfg)[79]);
  ok('내리는 값에는 하락 신호', trendSeries(dn, cfg)[79] === -1, trendSeries(dn, cfg)[79]);
  ok('평평하면 신호 없음', trendSeries(flat, cfg)[79] === 0, trendSeries(flat, cfg)[79]);
  const firstUp = trendSeries(up, cfg).findIndex((v) => v === 1);
  const firstDn = trendSeries(dn, cfg).findIndex((v) => v === -1);
  ok('숏은 롱보다 늦게 들어간다', firstDn > firstUp, `롱 ${firstUp}일, 숏 ${firstDn}일`);
  ok('이동평균이 값을 따라간다', Math.abs(ema(up, 10)[79] / up[79] - 1) < 0.12, ema(up, 10)[79]);
}

console.log('\n한도: 종목당 시드의 25%');
{
  let over = 0, checked = 0;
  for (let s = 1; s <= 60; s++) {
    const r = runBacktest(makeMarket({ seed: s, days: 141 }), {});
    for (const l of r.log) {
      if (l.kind !== 'open' && l.kind !== 'add') continue;
      checked++;
      if (l.symbolMargin > l.equity * DEFAULTS.symbolCapPct + 1e-6) over++;
    }
  }
  ok(`넣는 순간마다 한도를 지킨다 (${checked}번 확인)`, over === 0, over + '번 넘음');

  let over10 = 0;
  for (let s = 1; s <= 30; s++) {
    const r = runBacktest(makeMarket({ seed: s, days: 141 }), { symbolCapPct: 0.10 });
    for (const l of r.log) if ((l.kind === 'open' || l.kind === 'add') && l.symbolMargin > l.equity * 0.10 + 1e-6) over10++;
  }
  ok('한도를 10%로 낮추면 그것도 지킨다', over10 === 0, over10 + '번 넘음');
}

console.log('\n무손절이 정말 무손절인가');
{
  let stops = 0, negative = 0, closed = 0;
  for (let s = 1; s <= 60; s++) {
    const r = runBacktest(makeMarket({ seed: s, days: 141 }), {});
    for (const t of r.trades) {
      if (t.why === 'stop') stops++;
      if (t.why === 'target' || t.why === 'flip') { closed++; if (t.grossPnl < -1e-9) negative++; }
    }
  }
  ok('손절로 정리된 자리가 하나도 없다', stops === 0, stops + '건');
  ok(`스스로 판 자리는 전부 이익 (${closed}건)`, negative === 0, negative + '건이 손실');

  const m = many(80);
  const hidden = m.filter((x) => !x.ruined && x.openLosers > 0);
  ok('물린 자리는 안 판 채로 남는다', hidden.length > 0, '없음');
  ok('그 계좌들의 승률은 100%에 붙는다',
    hidden.every((x) => x.trades === 0 || x.winRate > 0.95),
    hidden.map((x) => x.winRate.toFixed(2)).join(','));
}

console.log('\n손절선을 켜면');
{
  const noStop = many(150);
  const withStop = many(150, {}, { stopLossPct: 0.20 });
  let stops = 0;
  for (let s = 1; s <= 20; s++) stops += runBacktest(makeMarket({ seed: s, days: 141 }), { stopLossPct: 0.20 }).trades.filter((t) => t.why === 'stop').length;
  ok('손절 매매가 실제로 생긴다', stops > 0, stops);
  ok('청산률이 내려간다', ruinRate(withStop) < ruinRate(noStop),
    `${(ruinRate(withStop) * 100).toFixed(0)}% vs ${(ruinRate(noStop) * 100).toFixed(0)}%`);
  const mddOf = (ms) => ms.map((x) => x.mdd).sort((a, b) => a - b)[Math.floor(ms.length / 2)];
  ok('최대낙폭 중앙값도 얕아진다', mddOf(withStop) > mddOf(noStop),
    `${(mddOf(withStop) * 100).toFixed(0)}% vs ${(mddOf(noStop) * 100).toFixed(0)}%`);
}

console.log('\n청산');
{
  const r = runBacktest(makeMarket({ seed: 2, days: 141 }), {});
  const m = metrics(r);
  ok('씨앗 2번은 청산당한다', m.ruined, '안 당함');
  ok('청산일 이후 자산은 0', r.equityCurve.slice(m.ruinDay).every((v) => v === 0), r.equityCurve[m.ruinDay + 1]);
  ok('청산일 이후 새 매매가 없다', r.trades.every((t) => t.closed <= m.ruinDay), '있음');
  ok('청산 뒤 남은 자리도 없다', r.openAtEnd.length === 0, r.openAtEnd.length);

  const lev = [1, 2, 3, 5].map((l) => ruinRate(many(120, {}, { leverage: l })));
  ok('배율이 높을수록 청산이 잦다', lev.every((v, i) => i === 0 || v >= lev[i - 1]),
    lev.map((v) => (v * 100).toFixed(0) + '%').join(' → '));
}

console.log('\n비용');
{
  const on = metrics(runBacktest(makeMarket({ seed: 3, days: 141 }), {}));
  const off = metrics(runBacktest(makeMarket({ seed: 3, days: 141 }), { fundingOn: false }));
  ok('펀딩을 끄면 펀딩비가 0', off.fundingPaid === 0, off.fundingPaid);
  ok('펀딩을 켜면 0이 아니다', Math.abs(on.fundingPaid) > 0, on.fundingPaid);
  const free = metrics(runBacktest(makeMarket({ seed: 3, days: 141 }), { feeRate: 0 }));
  ok('수수료가 없으면 결과가 더 좋다', free.multiple > on.multiple, `${free.multiple.toFixed(2)} vs ${on.multiple.toFixed(2)}`);
  ok('수수료 합계는 0보다 크다', on.feesPaid > 0, on.feesPaid);
}

console.log('\n물타기');
{
  // 계속 흘러내리는 종목 하나만 놓고 본다
  const days = 90;
  const closes = [];
  for (let i = 0; i < days; i++) closes.push(i < 40 ? 100 * Math.pow(1.02, i) : closes[39] * Math.pow(0.97, i - 39));
  const bars = closes.map((c, i) => ({ o: c, h: c * 1.01, l: c * 0.99, c }));
  const mk = (fund = 0) => ({ days, symbols: ['X'], bars: { X: bars }, funding: { X: bars.map(() => fund) }, synthetic: true });

  const withAdd = runBacktest(mk(), { maxAdds: 3, maxOpenSymbols: 1, takeProfitOnFlip: false });
  const noAdd = runBacktest(mk(), { maxAdds: 0, maxOpenSymbols: 1, takeProfitOnFlip: false });
  const adds = withAdd.log.filter((l) => l.kind === 'add');
  ok('밀리면 물을 탄다', adds.length > 0, '한 번도 안 탐');
  ok('물타기 횟수 상한을 지킨다', withAdd.log.filter((l) => l.kind === 'add').length <= 3 * 2, adds.length);
  ok('물을 타면 증거금이 커진다',
    (withAdd.openAtEnd[0]?.margin || 0) > (noAdd.openAtEnd[0]?.margin || 0) || withAdd.ruined,
    `${withAdd.openAtEnd[0]?.margin} vs ${noAdd.openAtEnd[0]?.margin}`);
  const p = withAdd.openAtEnd[0];
  if (p && p.side === 1 && p.adds > 0) ok('롱을 물타면 평단이 내려간다', p.avg < closes[p.opened], `${p.avg} vs ${closes[p.opened]}`);
  else ok('롱 물타기 평단 확인은 이번 데이터에 해당 없음', true, '');
}

console.log('\n결정성과 CSV');
{
  const a = metrics(runBacktest(makeMarket({ seed: 5, days: 141 }), {}));
  const b = metrics(runBacktest(makeMarket({ seed: 5, days: 141 }), {}));
  ok('같은 입력이면 같은 결과', JSON.stringify(a) === JSON.stringify(b), '다름');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-'));
  const m = makeMarket({ seed: 9, days: 60, symbolCount: 2 });
  for (const s of m.symbols) {
    const lines = ['date,open,high,low,close,funding'];
    m.bars[s].forEach((b, i) => lines.push(`2025-01-${String((i % 28) + 1).padStart(2, '0')},${b.o},${b.h},${b.l},${b.c},${m.funding[s][i]}`));
    fs.writeFileSync(path.join(dir, s + '.csv'), lines.join('\n'));
  }
  const loaded = loadCsvMarket(dir);
  ok('CSV 를 읽어 온다', loaded.symbols.length === 2 && loaded.days === 60, `${loaded.symbols} ${loaded.days}`);
  const same = loaded.symbols.every((s, i) =>
    Math.abs(loaded.bars[s][59].c - m.bars[m.symbols[i]][59].c) < 1e-6);
  ok('읽은 값이 원본과 같다', same, '다름');
  ok('CSV 로도 돌아간다', Number.isFinite(metrics(runBacktest(loaded, {})).multiple), '실패');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n되돌림이 있는 시장과 없는 시장');
{
  const none = many(150, { reboundStrength: 0, reboundTrigger: -0.04 });
  const strong = many(150, { reboundStrength: 1.0, reboundTrigger: -0.04 });
  ok('되돌림이 크면 무손절의 청산률이 내려간다', ruinRate(strong) < ruinRate(none),
    `${(ruinRate(strong) * 100).toFixed(0)}% vs ${(ruinRate(none) * 100).toFixed(0)}%`);
}

console.log(`\n${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
