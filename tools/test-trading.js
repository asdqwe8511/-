#!/usr/bin/env node
/* 차트 기법 엔진 점검.  node tools/test-trading.js
 *
 * 지표 공식이 알려진 값과 맞는지, CSV/JSON 을 여러 모양으로 읽는지,
 * 기법 목록의 항목이 전부 계산되는지 본다. 의존성 없음.
 */
'use strict';
const E = require('../trading-engine.js');
const I = E.ind;

let pass = 0, fail = 0;
const ok = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : '  → ' + (got === undefined ? '' : JSON.stringify(got))));
};
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);
const section = (t) => console.log('\n' + t);
const mk = (closes, opts) => closes.map((c, i) => Object.assign({
  date: '2024-01-' + String(i + 1).padStart(2, '0'), open: c, high: c, low: c, close: c, volume: 1000
}, opts && opts[i]));

section('이동평균');
{
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s = I.sma(v, 3);
  ok('SMA 앞부분은 null', s[0] === null && s[1] === null);
  ok('SMA(3) 세 번째 = 2', s[2] === 2, s[2]);
  ok('SMA(3) 마지막 = 9', s[9] === 9, s[9]);
  const e = I.ema([1, 2, 3, 4, 5], 3);
  ok('EMA 첫값은 SMA 로 시작 (2)', e[2] === 2, e[2]);
  ok('EMA 다음 = 3', e[3] === 3, e[3]);
  ok('EMA 그다음 = 4', e[4] === 4, e[4]);
  ok('EMA 길이 유지', e.length === 5);
  ok('SMA 가 null 을 건너뛰고 다시 채움', I.sma([1, 2, null, 4, 5, 6], 2)[5] === 5.5);
}

section('RSI (Wilder 예제 데이터)');
{
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328,
    45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835,
    45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
  const r = I.rsi(closes, 14);
  ok('14일 전엔 null', r[13] === null);
  ok('첫 RSI ≈ 70.53', near(r[14], 70.53, 0.05), r[14]);
  ok('다음 RSI ≈ 66.32', near(r[15], 66.32, 0.05), r[15]);
  ok('RSI 20번째 ≈ 57.97', near(r[19], 57.97, 0.1), r[19]);
  ok('마지막 RSI ≈ 37.77', near(r[32], 37.77, 0.1), r[32]);
  ok('계속 오르면 100', I.rsi([1, 2, 3, 4, 5, 6], 3)[5] === 100);
}

section('볼린저 · MACD · 스토캐스틱 · CCI');
{
  const flat = new Array(30).fill(100);
  const bb = I.bollinger(flat, 20, 2);
  ok('평평하면 밴드 폭 0', bb.upper[29] === 100 && bb.lower[29] === 100 && bb.middle[29] === 100);
  const v = [2, 4, 4, 4, 5, 5, 7, 9];       // 모표준편차 2
  ok('표준편차(모집단) = 2', near(I.stddev(v, 8)[7], 2));
  const bb2 = I.bollinger(v, 8, 2);
  ok('볼린저 상단 = 평균+2σ = 9', near(bb2.upper[7], 9) && near(bb2.lower[7], 1));
  const m = I.macd(flat.concat(flat), 12, 26, 9);
  ok('평평하면 MACD 0', near(m.macd[59], 0) && near(m.signal[59], 0) && near(m.hist[59], 0));
  ok('MACD 는 느린 EMA 가 생긴 뒤부터', m.macd[24] === null && m.macd[25] !== null);
  const rising = [];
  for (let i = 0; i < 60; i++) rising.push(100 + i);
  const m2 = I.macd(rising, 12, 26, 9);
  ok('오르는 추세면 MACD > 0', m2.macd[59] > 0);

  const bars = mk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const st = I.stochastic(bars, 5, 1, 3);
  ok('종가가 최고가면 %K = 100', st.k[9] === 100 && st.d[9] === 100);
  const bars2 = mk([10, 9, 8, 7, 6, 5]);
  ok('종가가 최저가면 %K = 0', I.stochastic(bars2, 5, 1, 3).k[5] === 0);
  ok('평평하면 CCI 0', I.cci(mk(new Array(25).fill(50)), 20)[24] === 0);
  const c = I.cci(mk([1, 2, 3, 4, 5, 6, 7, 8, 9, 30]), 5);
  ok('갑자기 뛰면 CCI 크게 양수', c[9] > 100, c[9]);
}

section('ATR · OBV');
{
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push({ date: '2024-01-' + String(i + 1).padStart(2, '0'), open: 100, high: 105, low: 95, close: 100, volume: 10 });
  const a = I.atr(bars, 14);
  ok('ATR 앞부분 null', a[12] === null);
  ok('갭 없이 폭이 10 이면 ATR 10', near(a[13], 10) && near(a[19], 10), a[19]);
  const tr = I.trueRange([{ high: 10, low: 8, close: 9 }, { high: 12, low: 11, close: 11 }]);
  ok('진폭에 갭 포함 (12-9=3)', tr[1] === 3, tr[1]);
  const o = I.obv(mk([10, 11, 11, 9, 12]));
  ok('OBV 누적 [0,1000,1000,0,1000]', JSON.stringify(o) === JSON.stringify([0, 1000, 1000, 0, 1000]), o);
}

section('일목균형표 · 파라볼릭 · 돈치안');
{
  const bars = E.generateSample(120, 3);
  const ich = I.ichimoku(bars, 9, 26, 52);
  ok('선행스팬은 26봉 앞으로 (길이 n+26)', ich.spanA.length === 146 && ich.spanB.length === 146);
  ok('선행A 는 전환·기준 평균을 앞으로 민 것', near(ich.spanA[26 + 30], (ich.tenkan[30] + ich.kijun[30]) / 2));
  ok('후행스팬은 종가를 26봉 뒤로', ich.chikou[10] === bars[36].close && ich.chikou[100] === null);
  const hi = I.highest(bars.map((b) => b.high), 9), lo = I.lowest(bars.map((b) => b.low), 9);
  ok('전환선 = (9일 고가+저가)/2', near(ich.tenkan[50], (hi[50] + lo[50]) / 2));

  const sar = I.parabolicSar(bars, 0.02, 0.2);
  ok('SAR 두 번째 봉부터 값', sar.sar[0] === null && sar.sar[1] !== null);
  let inside = 0;
  for (let i = 2; i < bars.length; i++) {
    if (sar.dir[i] > 0 && sar.sar[i] > bars[i].low) inside++;
    if (sar.dir[i] < 0 && sar.sar[i] < bars[i].high) inside++;
  }
  ok('SAR 점은 항상 봉 바깥쪽 (반전 봉 제외)', inside <= bars.length * 0.05, inside);
  ok('SAR 방향이 바뀌는 날이 있다', new Set(sar.dir.slice(2)).size === 2);

  ok('돈치안 상단은 20일 최고가', I.highest(bars.map((b) => b.high), 20)[40] === Math.max.apply(null, bars.slice(21, 41).map((b) => b.high)));
}

section('피봇 · 스윙 · 교차');
{
  // 1월(3봉) 다음 2월(2봉). 2월의 피봇은 1월 고·저·종가로.
  const bars = [
    { date: '2024-01-29', open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { date: '2024-01-30', open: 11, high: 15, low: 10, close: 14, volume: 1 },
    { date: '2024-01-31', open: 14, high: 14, low: 6, close: 9, volume: 1 },
    { date: '2024-02-01', open: 9, high: 10, low: 8, close: 9, volume: 1 },
    { date: '2024-02-02', open: 9, high: 11, low: 8, close: 10, volume: 1 }
  ];
  const pv = I.pivotPoints(bars, 'month');
  ok('첫 기간엔 피봇 없음', pv.p[2] === null);
  const P = (15 + 6 + 9) / 3;
  ok('월 피봇 P = (15+6+9)/3', near(pv.p[3], P) && near(pv.p[4], P), pv.p[3]);
  ok('R1 = 2P − 저가, S1 = 2P − 고가', near(pv.r1[3], 2 * P - 6) && near(pv.s1[3], 2 * P - 15));
  ok('R2 = P + (고−저)', near(pv.r2[3], P + 9) && near(pv.s2[3], P - 9));
  const pd = I.pivotPoints(bars, 'day');
  ok('일 피봇은 전날 기준', near(pd.p[1], (12 + 9 + 11) / 3));
  const pw = I.pivotPoints([
    { date: '2024-01-05', open: 1, high: 3, low: 1, close: 2, volume: 1 },   // 금요일 (1주)
    { date: '2024-01-08', open: 2, high: 2, low: 2, close: 2, volume: 1 }    // 월요일 (2주)
  ], 'week');
  ok('주 피봇은 지난주 기준', near(pw.p[1], 2) && pw.p[0] === null);

  const sw = I.swings(mk([1, 2, 3, 9, 3, 2, 1, 2, 3, 1, 5, 4]), 2);
  ok('스윙 고점 = 3번(9). 10번(5)은 오른쪽 봉이 모자라 아직 아님', JSON.stringify(sw.highs) === JSON.stringify([3]), sw.highs);
  ok('스윙 저점 = 6번(1), 9번(1)', JSON.stringify(sw.lows) === JSON.stringify([6, 9]), sw.lows);

  const a = [1, 2, 3, 2, 1], b = [2, 2, 2, 2, 2];
  ok('위로 뚫음 +1', I.crossAt(a, b, 2) === 1);
  ok('아래로 뚫음 -1', I.crossAt(a, b, 4) === -1);
  ok('교차 없음 0', I.crossAt(a, b, 1) === 0 && I.crossAt(a, b, 0) === 0);
  ok('null 이 끼면 0', I.crossAt([null, 3], [2, 2], 1) === 0);
}

section('CSV 읽기');
{
  const kr = '날짜,종가,대비,등락률,시가,고가,저가,거래량\n' +
    '2024.01.03,"72,000",-500,-0.69,"72,300","72,600","71,800","1,234,567"\n' +
    '2024.01.02,"72,500",100,0.14,"72,000","73,000","71,900","987,654"\n';
  const b = E.parseCsv(kr);
  ok('한국 증권사 형식(따옴표·쉼표 숫자)', b.length === 2);
  ok('날짜 오름차순으로 정렬', b[0].date === '2024-01-02' && b[1].date === '2024-01-03');
  ok('값이 제대로', b[1].close === 72000 && b[1].open === 72300 && b[1].high === 72600 && b[1].low === 71800 && b[1].volume === 1234567, b[1]);

  const en = 'Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-02,100,110,90,105,104.5,5000\n2024-01-03,105,106,100,101,100.6,4000\n';
  const e = E.parseCsv(en);
  ok('영문 헤더', e.length === 2 && e[0].close === 105 && e[1].volume === 4000);

  const adjOnly = 'Date,Adj Close\n2024-01-02,10\n2024-01-03,11\n';
  const ad = E.parseCsv(adjOnly);
  ok('종가 없이 수정종가만 있어도 읽음', ad.length === 2 && ad[1].close === 11 && ad[1].high === 11 && ad[1].open === 11);

  const noHeader = '20240102\t100\t110\t90\t105\t5000\n20240103\t105\t106\t100\t101\t4000\n';
  const nh = E.parseCsv(noHeader);
  ok('헤더 없는 탭 구분 (날짜,시,고,저,종,량 순)', nh.length === 2 && nh[0].date === '2024-01-02' && nh[0].high === 110);

  const semi = 'date;close\n2024/1/2;10\n2024/1/3;11\n';
  ok('세미콜론 구분 + 2024/1/2 날짜', E.parseCsv(semi)[0].date === '2024-01-02');

  const dup = 'date,close\n2024-01-02,10\n2024-01-02,12\n';
  const d = E.parseCsv(dup);
  ok('같은 날짜는 뒤의 것으로', d.length === 1 && d[0].close === 12);

  const bom = '﻿날짜,종가\n2024-01-02,10\n';
  ok('BOM 붙은 파일', E.parseCsv(bom).length === 1);

  const withTime = 'datetime,open,high,low,close,volume\n2024-01-02 09:00,1,2,0.5,1.5,10\n2024-01-02 10:00,1.5,2,1,1.2,10\n';
  const wt = E.parseCsv(withTime);
  ok('시각이 있는 분봉은 시각까지 구분', wt.length === 2 && wt[0].date === '2024-01-02 09:00');

  const bad = 'a,b\n1,2\n';
  let threw = null;
  try { E.parseCsv(bad); } catch (x) { threw = x.message; }
  ok('날짜 열이 없으면 안내 오류', /날짜/.test(threw || ''), threw);

  ok('고가가 시·종가보다 낮으면 고쳐 줌', E.parseCsv('date,open,high,low,close\n2024-01-02,10,9,9,12\n')[0].high === 12);
}

section('JSON 읽기 · 날짜 · 숫자');
{
  const j1 = E.parseJson('{"bars":[{"date":"2024-01-02","open":1,"high":2,"low":0.5,"close":1.5,"volume":3}]}');
  ok('{bars:[...]} 모양', j1.length === 1 && j1[0].close === 1.5);
  const j2 = E.parseJson([[1704153600, 1, 2, 0.5, 1.5, 3], ['2024-01-03', 1, 2, 0.5, 1.7, 3]]);
  ok('배열의 배열 + 유닉스 초', j2.length === 2 && j2[0].date === '2024-01-02' && j2[1].close === 1.7, j2);
  const j3 = E.parseJson([{ 날짜: '20240102', 종가: '1,000' }]);
  ok('한글 키 + 문자열 숫자', j3[0].close === 1000);
  ok('parseAny 는 모양을 보고 고름', E.parseAny(' [{"date":"2024-01-02","close":3}]')[0].close === 3 && E.parseAny('date,close\n2024-01-02,4')[0].close === 4);

  ok('toDateKey 2024년 1월 2일', E.toDateKey('2024년 1월 2일') === '2024-01-02');
  ok('toDateKey 01/02/2024 (미국식)', E.toDateKey('01/02/2024') === '2024-01-02');
  ok('toDateKey 밀리초', E.toDateKey(1704153600000) === '2024-01-02');
  ok('toDateKey 쓰레기는 null', E.toDateKey('abc') === null && E.toDateKey('') === null);
  ok('toNumber "1,234.5" / "₩1,000" / ""', E.toNumber('1,234.5') === 1234.5 && E.toNumber('₩1,000') === 1000 && isNaN(E.toNumber('')));
}

section('샘플 데이터 · 요약');
{
  const a = E.generateSample(50, 1, '2024-03-15'), b = E.generateSample(50, 1, '2024-03-15');
  ok('같은 seed 면 같은 데이터', JSON.stringify(a) === JSON.stringify(b));
  ok('50봉, 마지막 날짜가 지정한 날', a.length === 50 && a[49].date === '2024-03-15');
  ok('주말이 없다', a.every((x) => { const d = new Date(x.date + 'T00:00:00Z').getUTCDay(); return d !== 0 && d !== 6; }));
  ok('고가 ≥ 시·종가 ≥ 저가', a.every((x) => x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close)));
  ok('다른 seed 는 다른 데이터', JSON.stringify(E.generateSample(50, 2, '2024-03-15')) !== JSON.stringify(a));
  const s = E.summarize(a);
  ok('요약: 개수·기간·고저', s.count === 50 && s.from === a[0].date && s.to === '2024-03-15' && s.high >= s.close && s.low <= s.close);
  ok('빈 데이터 요약은 null', E.summarize([]) === null);
}

section('기법 목록');
{
  const bars = E.generateSample(200, 11);
  const ids = new Set();
  E.TECHNIQUES.forEach((t) => {
    ok('[' + t.id + '] 모양이 갖춰짐', typeof t.compute === 'function' && t.name && t.desc && ['pattern', 'trend', 'momentum', 'signal'].indexOf(t.group) >= 0 && Array.isArray(t.params));
    ok('[' + t.id + '] id 중복 없음', !ids.has(t.id)); ids.add(t.id);
    const r = t.compute(bars, E.normalizeParams(t, null)) || {};
    let good = true;
    (r.overlays || []).forEach((o) => {
      ['values', 'upper', 'lower', 'middle', 'a', 'b'].forEach((k) => { if (o[k] && o[k].length < bars.length) good = false; });
      if (o.kind === 'levels' && !Array.isArray(o.levels)) good = false;
    });
    if (r.panel) r.panel.series.forEach((s) => { if (!s.values || s.values.length !== bars.length) good = false; });
    (r.markers || []).forEach((m) => { if (!(m.index >= 0 && m.index < bars.length) || !['buy', 'sell', 'note', 'target', 'stop', 'expired'].includes(m.type) || !m.text) good = false; });
    (r.overlays || []).forEach((o) => {
      if (o.kind === 'zones') o.zones.forEach((z) => { if (!(z.from <= z.to && z.from >= 0 && z.to < bars.length)) good = false; });
      if (o.kind === 'segments') o.segments.forEach((sg) => { if (!(sg.from <= sg.to && isFinite(sg.price))) good = false; });
      if (o.kind === 'paths') o.paths.forEach((pt) => { if (!pt.points.every((q) => q.index >= 0 && q.index < bars.length && isFinite(q.price))) good = false; });
    });
    if (t.group === 'pattern') {
      const entries = (r.markers || []).filter((m) => m.strategy), exits = (r.markers || []).filter((m) => m.exit);
      const okEntries = entries.every((m) => isFinite(m.entry) && isFinite(m.target) && isFinite(m.stop) && m.outcome && E.OUTCOME_TEXT[m.outcome.result]
        && (m.side === 'long' ? m.target > m.entry && m.stop < m.entry : m.target < m.entry && m.stop > m.entry));
      ok('[' + t.id + '] 진입마다 목표·손절이 진입가의 올바른 쪽에 있음 (' + entries.length + '건)', okEntries);
      ok('[' + t.id + '] 청산 표시는 진입보다 뒤 봉에', exits.every((x) => x.index > x.entryIndex && x.index < bars.length));
      ok('[' + t.id + '] 결과가 난 진입에는 청산 표시가 있음', entries.filter((m) => m.outcome.exitIndex != null).length === exits.length);
    }
    ok('[' + t.id + '] 출력 길이·인덱스가 맞음', good);
    ok('[' + t.id + '] 그룹에 맞는 출력', t.group === 'momentum' ? !!r.panel : t.group === 'trend' ? (r.overlays || []).length > 0 : (r.markers || []).length >= 0);
  });
  ok('그룹마다 기법이 있다', E.GROUPS.every((g) => E.TECHNIQUES.some((t) => t.group === g.id)));

  const study = E.buildStudy(bars, E.TECHNIQUES.map((t) => t.id));
  ok('buildStudy: 오류 없음', study.errors.length === 0, study.errors);
  ok('buildStudy: 패널 수 = 모멘텀 기법 수', study.panels.length === E.TECHNIQUES.filter((t) => t.group === 'momentum').length);
  ok('buildStudy: 일목균형표 때문에 오른쪽 여백 26', study.extra === 26, study.extra);
  ok('buildStudy: 마커에 날짜·기법명이 붙고 날짜순', study.markers.every((m) => m.date && m.techName) && study.markers.every((m, i) => i === 0 || m.index >= study.markers[i - 1].index));
  ok('buildStudy: 모르는 id 는 무시', E.buildStudy(bars, ['없는기법']).overlays.length === 0);
  ok('buildStudy: 문자열 id 도 됨', E.buildStudy(bars, ['sma']).overlays.length === 4);

  const smaCustom = E.buildStudy(bars, [{ id: 'sma', params: { periods: '10, 30' } }]);
  ok('SMA 기간 목록 파라미터', smaCustom.overlays.length === 2 && smaCustom.overlays[1].name === 'SMA 30');
  const rsi = E.techniqueById('rsi');
  const np = E.normalizeParams(rsi, { period: '999', hi: 'abc', lo: -5 });
  ok('파라미터 정리: 상한·기본값·하한', np.period === 200 && np.hi === 70 && np.lo === 1, np);
  ok('select 파라미터 잘못되면 기본값', E.normalizeParams(E.techniqueById('pivot'), { mode: 'year' }).mode === 'month');
  const ich = E.normalizeParams(E.techniqueById('ichimoku'), null);
  ok('값이 없으면 기본값 (0 이나 최소값이 아니라)', ich.tenkan === 9 && ich.kijun === 26 && ich.senkou === 52, ich);
  ok('빈 문자열도 기본값', E.normalizeParams(rsi, { period: '' }).period === 14);

  // 골든크로스: 내려가다 올라가는 데이터에서 매수 신호가 잡히는지
  const v = [];
  for (let i = 0; i < 40; i++) v.push(100 - i);
  for (let i = 0; i < 40; i++) v.push(60 + i * 1.5);
  const cross = E.buildStudy(mk(v), [{ id: 'sig_macross', params: { fast: 5, slow: 20 } }]);
  ok('골든크로스 매수 신호 1개, 상승 전환 뒤에', cross.markers.filter((m) => m.type === 'buy').length === 1 && cross.markers[0].index > 40, cross.markers);
  const gap = E.buildStudy(mk([100, 100, 110, 110, 100]), [{ id: 'sig_gap', params: { pct: 2 } }]);
  ok('갭 상승·하락 각각 1개', gap.markers.length === 2 && /갭 상승/.test(gap.markers[0].text) && /갭 하락/.test(gap.markers[1].text), gap.markers);
  // 패턴이 켜져도 매매 신호가 같이 잘 나오는지
  const vol = E.buildStudy(mk(new Array(30).fill(10), { 29: { volume: 5000 } }), [{ id: 'sig_volume', params: { ma: 20, mult: 2.5 } }]);
  ok('거래량 급증 표시', vol.markers.length === 1 && vol.markers[0].index === 29 && /×5\.0/.test(vol.markers[0].text), vol.markers);
}

section('매매 따라가기 (목표·손절)');
{
  const ohlc = (rows) => rows.map((r, i) => ({ date: '2024-02-' + String(i + 1).padStart(2, '0'), open: r[0], high: r[1], low: r[2], close: r[3], volume: 1000 }));
  const bars = ohlc([[100, 101, 99, 100], [100, 103, 99, 102], [102, 106, 101, 105], [105, 112, 104, 111], [111, 113, 108, 109]]);
  const t = E.simulateTrade(bars, 0, 'long', 110, 95, 10);
  ok('목표가 110 은 4번째 봉(고가 112)에서 도달', t.result === 'target' && t.exitIndex === 3 && t.exitPrice === 110 && near(t.pct, 10), t);
  const st = E.simulateTrade(bars, 0, 'long', 120, 99.5, 10);
  ok('손절 99.5 는 1번째 봉(저가 99)에서', st.result === 'stop' && st.exitIndex === 1 && st.exitPrice === 99.5, st);
  const gap = E.simulateTrade(ohlc([[100, 100, 100, 100], [90, 92, 88, 91]]), 0, 'long', 120, 95, 10);
  ok('갭으로 건너뛰면 시가에 손절', gap.result === 'stop' && gap.exitPrice === 90, gap);
  const both = E.simulateTrade(ohlc([[100, 100, 100, 100], [100, 130, 80, 100]]), 0, 'long', 110, 90, 10);
  ok('한 봉에서 둘 다 닿으면 손절로 침', both.result === 'stop', both);
  const sh = E.simulateTrade(ohlc([[100, 100, 100, 100], [99, 99, 92, 93]]), 0, 'short', 95, 105, 10);
  ok('공매도는 목표가 아래쪽', sh.result === 'target' && sh.exitPrice === 95 && near(sh.pct, 100 / 95 * 100 - 100), sh);
  const open = E.simulateTrade(bars, 3, 'long', 130, 100, 10);
  ok('봉이 모자라면 진행 중', open.result === 'open' && open.exitIndex === null);
  const exp = E.simulateTrade(bars, 0, 'long', 130, 90, 3);
  ok('보유 봉수를 넘기면 기간 만료, 그 봉 종가로', exp.result === 'expired' && exp.exitIndex === 3 && exp.exitPrice === 111, exp);

  const asm = E.assembleTrades(bars, [{ index: 0, side: 'long', text: '테스트', entry: 100, target: 110, stop: 95, horizon: 10, from: 0, path: [{ index: 0, price: 100 }] }], '#ffb347');
  ok('진입 + 청산 마커 2개', asm.markers.length === 2 && asm.markers[0].type === 'buy' && asm.markers[1].type === 'target' && asm.markers[1].exit === true && asm.markers[1].index === 3);
  ok('목표·손절 선은 진입부터 청산까지', asm.overlays.some((o) => o.kind === 'segments' && o.segments.length === 2 && o.segments.every((sg) => sg.from === 0 && sg.to === 3)));
  ok('윤곽선 overlay', asm.overlays.some((o) => o.kind === 'paths'));
}

section('패턴 인식');
{
  const ohlc = (rows) => rows.map((r, i) => ({ date: '2024-03-' + String(i + 1).padStart(2, '0'), open: r[0], high: r[1], low: r[2], close: r[3], volume: 1000 }));
  // 적삼병: 세 양봉이 계단처럼, 시가는 전 봉 몸통 안
  const three = ohlc([[100, 101, 99, 100], [100, 104, 99, 103], [102, 107, 101, 106], [105, 110, 104, 109], [109, 110, 108, 109]]);
  const t3 = E.buildStudy(three, ['pat_three']).markers.filter((m) => m.strategy);
  ok('적삼병 인식 (3번째 봉에서 진입)', t3.length === 1 && t3[0].index === 3 && /적삼병/.test(t3[0].text) && t3[0].type === 'buy', t3);
  ok('적삼병 목표 = 진입 + 세 봉 높이(109-100), 손절 = 세 봉 최저가', t3.length === 1 && near(t3[0].target, 118) && near(t3[0].stop, 99), t3[0]);
  const crows = ohlc([[100, 101, 99, 100], [100, 101, 96, 97], [98, 99, 93, 94], [95, 96, 90, 91]]);
  const tc = E.buildStudy(crows, ['pat_three']).markers.filter((m) => m.strategy);
  ok('흑삼병 인식 (매도)', tc.length === 1 && tc[0].type === 'sell' && /흑삼병/.test(tc[0].text) && tc[0].target < tc[0].entry, tc);
  ok('양봉 셋이라도 계단이 아니면 아님', E.buildStudy(ohlc([[100, 105, 99, 104], [90, 95, 89, 94], [80, 85, 79, 84]]), ['pat_three']).markers.length === 0);

  // 장악형
  const eng = ohlc([[100, 101, 97, 98], [97, 103, 96, 102]]);
  const te = E.buildStudy(eng, ['pat_engulf']).markers.filter((m) => m.strategy);
  ok('상승 장악형: 손절 = 오늘 저가, 목표 = 진입 + 2×손절폭', te.length === 1 && te[0].stop === 96 && near(te[0].target, 102 + 2 * 6), te);

  // 망치형: 하락 뒤 긴 아래꼬리
  const ham = [];
  for (let i = 0; i < 12; i++) ham.push([100 - i, 100.5 - i, 99 - i, 99.5 - i]);
  ham.push([88, 88.5, 82, 88.3]);
  const th = E.buildStudy(ohlc(ham), ['pat_hammer']).markers.filter((m) => m.strategy);
  ok('망치형 인식, 손절 = 꼬리 끝(82)', th.length === 1 && /망치형/.test(th[0].text) && th[0].stop === 82, th);

  // 샛별형
  const star = ohlc([[110, 111, 104, 105], [104, 104.6, 103.5, 104.4], [104.8, 110, 104.5, 109]]);
  const ts = E.buildStudy(star, ['pat_star']).markers.filter((m) => m.strategy);
  ok('샛별형 인식', ts.length === 1 && /샛별형/.test(ts[0].text) && ts[0].stop === 103.5, ts);

  // 컵앤핸들: 둥근 바닥 40봉 + 손잡이 8봉 + 돌파
  const cup = [];
  for (let i = 0; i < 6; i++) { const px = 94 + i; cup.push([px, px + 1, px - 1, px]); }        // 왼쪽 가장자리로 올라옴
  for (let i = 0; i <= 40; i++) { const px = 100 - 20 * Math.sin(Math.PI * i / 40); cup.push([px, px + 1, px - 1, px]); }
  for (let i = 0; i < 8; i++) { const px = 100 - 4 * Math.sin(Math.PI * i / 8); cup.push([px, px + 0.5, px - 0.5, px]); }
  cup.push([100, 104, 99.5, 103.5]);
  for (let i = 0; i < 5; i++) cup.push([104, 106, 103, 105]);
  const cupBars = ohlc(cup);
  const tcup = E.buildStudy(cupBars, [{ id: 'pat_cup', params: { minLen: 20, maxLen: 120, depth: 12 } }]);
  const cupEntries = tcup.markers.filter((m) => m.strategy);
  ok('컵앤핸들 돌파 인식', cupEntries.length === 1 && /컵앤핸들/.test(cupEntries[0].text), cupEntries);
  ok('컵앤핸들 목표 = 돌파가 + 컵 깊이(≈21), 손절 = 손잡이 저점', cupEntries.length === 1 && cupEntries[0].target > cupEntries[0].entry + 18 && cupEntries[0].stop < 97 && cupEntries[0].stop > 90, cupEntries[0]);
  ok('컵 윤곽선 5점 + 가장자리 선', tcup.overlays.some((o) => o.kind === 'paths' && o.paths[0].points.length === 5) && tcup.overlays.some((o) => o.kind === 'segments' && o.segments.some((sg) => /가장자리/.test(sg.label))));

  // 쌍바닥: 바닥 둘, 사이 고점 돌파
  const dbl = [];
  const push = (px) => dbl.push([px, px + 0.5, px - 0.5, px]);
  for (let i = 0; i < 10; i++) push(100 - i * 2);          // 80 까지
  for (let i = 0; i < 10; i++) push(80 + i * 1.5);         // 93.5 까지 반등
  for (let i = 0; i < 10; i++) push(95 - i * 1.5);         // 80.5 로 다시
  for (let i = 0; i < 12; i++) push(81 + i * 1.6);         // 목선(≈95) 돌파
  const tdb = E.buildStudy(ohlc(dbl), [{ id: 'pat_double', params: { n: 4, tol: 3 } }]).markers.filter((m) => m.strategy);
  ok('쌍바닥 돌파 인식', tdb.length === 1 && /쌍바닥/.test(tdb[0].text) && tdb[0].type === 'buy', tdb);
  ok('쌍바닥 목표 = 진입 + (목선-바닥)', tdb.length === 1 && near(tdb[0].target - tdb[0].entry, 95.5 - 80, 1), tdb[0]);

  // 헤드앤숄더
  const hs = [];
  const seg = (from, to, n) => { for (let i = 0; i < n; i++) { const px = from + (to - from) * i / n; hs.push([px, px + 0.5, px - 0.5, px]); } };
  seg(80, 100, 10); seg(100, 90, 8); seg(90, 115, 10); seg(115, 91, 10); seg(91, 101, 8); seg(101, 85, 12);
  const ths = E.buildStudy(ohlc(hs), [{ id: 'pat_hs', params: { n: 4, tol: 5 } }]);
  const hsE = ths.markers.filter((m) => m.strategy);
  ok('헤드앤숄더 목선 이탈 인식 (매도)', hsE.length === 1 && hsE[0].type === 'sell' && /헤드앤숄더/.test(hsE[0].text), hsE);
  ok('헤드앤숄더 손절 = 오른쪽 어깨 고가', hsE.length === 1 && near(hsE[0].stop, 101.5, 1.5), hsE[0]);
  ok('목선은 두 점 꺾은선으로', ths.overlays.some((o) => o.kind === 'paths' && o.paths.some((pt) => pt.label === '목선' && pt.points.length === 2)));

  // 박스권 돌파
  const box = [];
  for (let i = 0; i < 25; i++) box.push([100 + (i % 3), 102, 99, 100 + ((i + 1) % 3)]);
  box.push([102, 108, 101.5, 107]);
  const tb = E.buildStudy(ohlc(box), [{ id: 'strat_box', params: { n: 20, width: 10 } }]).markers.filter((m) => m.strategy);
  ok('박스 상향 돌파: 목표 = 진입 + 박스 높이(3), 손절 = 가운데(100.5)', tb.length === 1 && near(tb[0].target, 110) && near(tb[0].stop, 100.5), tb);

  // 볼린저 되돌림
  const bbr = [];
  for (let i = 0; i < 25; i++) bbr.push([100, 101, 99, 100 + (i % 2 ? 0.5 : -0.5)]);
  bbr.push([99, 99, 92, 93]); bbr.push([93, 99, 92.5, 98.5]);
  const tbb = E.buildStudy(ohlc(bbr), [{ id: 'strat_bb', params: { mode: 'revert', period: 20, mult: 2 } }]).markers.filter((m) => m.strategy);
  ok('볼린저 하단 되돌림: 밴드 밖→안에서 매수, 손절 = 그동안 최저가(92)', tbb.length === 1 && tbb[0].type === 'buy' && tbb[0].stop === 92 && tbb[0].target > tbb[0].entry, tbb);

  // 눌림목
  const pb = [];
  for (let i = 0; i < 70; i++) pb.push([100 + i, 101 + i, 99.5 + i, 100.6 + i]);   // 꾸준한 상승
  const ma20 = 100.6 + 69 - 9.5;                                                    // 대략 마지막 20봉 평균
  pb.push([170, 170.5, ma20 - 0.5, 170.3]);                                         // 단기선까지 눌렸다가 양봉
  const tpb = E.buildStudy(ohlc(pb), ['strat_pullback']).markers.filter((m) => m.strategy);
  ok('눌림목 매수 인식', tpb.length >= 1 && tpb[tpb.length - 1].index === 70 && /눌림목/.test(tpb[tpb.length - 1].text), tpb);

  ok('패턴 그룹이 목록 첫 번째', E.GROUPS[0].id === 'pattern');
}

console.log('\n' + pass + ' 통과, ' + fail + ' 실패');
process.exit(fail ? 1 : 0);
