/* 사주(四柱) + 성명(姓名) 계산 엔진.
 *
 * 브라우저(<script src="/saju-engine.js">)와 Node(require) 양쪽에서 같은 코드를
 * 씁니다. 화면에 즉시 그리는 만세력 표와, 서버가 Claude에게 넘기는 프롬프트가
 * 같은 계산 결과에서 나와야 하기 때문입니다.
 *
 * 계산은 전부 천문 계산 기반입니다(절기 표를 하드코딩하지 않음).
 *   - 태양 황경  : Meeus, Astronomical Algorithms 2nd ed. ch.25 (저정밀, ±0.01°)
 *   - 삭(신월)   : 같은 책 ch.49 (음력 변환용)
 *   - ΔT        : Espenak & Meeus 다항식 근사
 * 절기 경계는 "출생 순간의 태양 황경"으로 바로 판정하므로, 절입 시각 표의
 * 반올림 오차가 끼어들 여지가 없습니다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SajuEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 기본 상수 ──────────────────────────────────────────────────────────
  var STEM   = ['갑','을','병','정','무','기','경','신','임','계'];
  var STEM_H = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  var BRANCH  = ['자','축','인','묘','진','사','오','미','신','유','술','해'];
  var BRANCH_H= ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
  var BRANCH_ANIMAL = ['쥐','소','호랑이','토끼','용','뱀','말','양','원숭이','닭','개','돼지'];

  var STEM_ELEM   = ['목','목','화','화','토','토','금','금','수','수'];
  var BRANCH_ELEM = ['수','토','목','목','토','화','화','토','금','금','토','수'];
  // 양(+) = true. 천간·지지 모두 짝수 인덱스가 양.
  function isYang(i) { return i % 2 === 0; }

  var ELEMS = ['목','화','토','금','수'];
  var ELEM_H = { 목:'木', 화:'火', 토:'土', 금:'金', 수:'水' };
  var ELEM_COLOR = { 목:'청', 화:'적', 토:'황', 금:'백', 수:'흑' };
  // 상생: 목→화→토→금→수→목 / 상극: 목→토→수→화→금→목
  function generates(a, b) { return ELEMS[(ELEMS.indexOf(a) + 1) % 5] === b; }
  function controls(a, b)  { return ELEMS[(ELEMS.indexOf(a) + 2) % 5] === b; }

  // 지장간 (여기 / 중기 / 정기, 배당 일수)
  var HIDDEN = [
    [[8,10],[9,20]],                     // 子: 壬 癸
    [[9,9],[7,3],[5,18]],                // 丑: 癸 辛 己
    [[4,7],[2,7],[0,16]],                // 寅: 戊 丙 甲
    [[0,10],[1,20]],                     // 卯: 甲 乙
    [[1,9],[9,3],[4,18]],                // 辰: 乙 癸 戊
    [[4,7],[6,7],[2,16]],                // 巳: 戊 庚 丙
    [[2,10],[5,9],[3,11]],               // 午: 丙 己 丁
    [[3,9],[1,3],[5,18]],                // 未: 丁 乙 己
    [[4,7],[8,7],[6,16]],                // 申: 戊 壬 庚
    [[6,10],[7,20]],                     // 酉: 庚 辛
    [[7,9],[3,3],[4,18]],                // 戌: 辛 丁 戊
    [[4,7],[0,7],[8,16]]                 // 亥: 戊 甲 壬
  ];

  var SEASON_OF_BRANCH = ['겨울','겨울','봄','봄','봄','여름','여름','여름','가을','가을','가을','겨울'];

  // ── 각도/시간 유틸 ─────────────────────────────────────────────────────
  var D2R = Math.PI / 180;
  function norm360(x) { x = x % 360; return x < 0 ? x + 360 : x; }
  function sinD(x) { return Math.sin(x * D2R); }
  function cosD(x) { return Math.cos(x * D2R); }

  // 그레고리력 (UTC) → 율리우스일
  function toJD(y, m, d, hourFrac) {
    if (m <= 2) { y -= 1; m += 12; }
    var a = Math.floor(y / 100);
    var b = 2 - a + Math.floor(a / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
         + d + b - 1524.5 + (hourFrac || 0) / 24;
  }
  function fromJD(jd) {
    var z = Math.floor(jd + 0.5), f = jd + 0.5 - z, a = z;
    if (z >= 2299161) {
      var alpha = Math.floor((z - 1867216.25) / 36524.25);
      a = z + 1 + alpha - Math.floor(alpha / 4);
    }
    var b = a + 1524, c = Math.floor((b - 122.1) / 365.25),
        d = Math.floor(365.25 * c), e = Math.floor((b - d) / 30.6001);
    var day = b - d - Math.floor(30.6001 * e) + f;
    var month = e < 14 ? e - 1 : e - 13;
    var year = month > 2 ? c - 4716 : c - 4715;
    var dayInt = Math.floor(day), hour = (day - dayInt) * 24;
    return { y: year, m: month, d: dayInt, hour: hour };
  }

  // ΔT (TT - UT), 초 단위. Espenak & Meeus 근사.
  function deltaTSeconds(year) {
    var t, u;
    if (year < 1900) { t = (year - 1860) / 100; return 7.62 + 57.37 * t - 2.6404 * t * t; }
    if (year < 1920) { t = year - 1900; return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t * t * t - 0.000197 * Math.pow(t, 4); }
    if (year < 1941) { t = year - 1920; return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t * t * t; }
    if (year < 1961) { t = year - 1950; return 29.07 + 0.407 * t - t * t / 233 + t * t * t / 2547; }
    if (year < 1986) { t = year - 1975; return 45.45 + 1.067 * t - t * t / 260 - t * t * t / 718; }
    if (year < 2005) { t = year - 2000; return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t + 0.000651814 * Math.pow(t, 4) + 0.00002373599 * Math.pow(t, 5); }
    if (year < 2050) { t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
    u = (year - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - year);
  }
  function jdUTtoTT(jd) {
    var y = fromJD(jd).y;
    return jd + deltaTSeconds(y) / 86400;
  }

  // 태양 겉보기 황경(도). 인자는 TT 기준 율리우스일.
  //
  // VSOP87 지구 황경 급수를 절단해 쓴다(Meeus 부록 III). 저정밀 공식(±0.01°)은
  // 절기 시각을 5~8분 어긋나게 만드는데, 절입 직전·직후에 태어난 사람은 월주와
  // 연주가 통째로 바뀌므로 그 오차를 그대로 둘 수 없다. 아래 급수는 ±0.001°
  // 수준이라 절기 시각 오차가 1분 안쪽이다.
  var VSOP_L0 = [
    [175347046,0,0],[3341656,4.6692568,6283.07585],[34894,4.6261,12566.1517],
    [3497,2.7441,5753.3849],[3418,2.8289,3.5231],[3136,3.6277,77713.7715],
    [2676,4.4181,7860.4194],[2343,6.1352,3930.2097],[1324,0.7425,11506.7698],
    [1273,2.0371,529.691],[1199,1.1096,1577.3435],[990,5.233,5884.927],
    [902,2.045,26.298],[857,3.508,398.149],[780,1.179,5223.694],
    [753,2.533,5507.553],[505,4.583,18849.228],[492,4.205,775.523],
    [357,2.92,0.067],[317,5.849,11790.629],[284,1.899,796.298],
    [271,0.315,10977.079],[243,0.345,5486.778],[206,4.806,2544.314],
    [205,1.869,5573.143],[202,2.458,6069.777],[156,0.833,213.299],
    [132,3.411,2942.463],[126,1.083,20.775],[115,0.645,0.98],
    [103,0.636,4694.003],[102,0.976,15720.839],[102,4.267,7.114],
    [99,6.21,2146.17],[98,0.68,155.42],[86,5.98,161000.69],
    [85,1.30,6275.96],[85,3.67,71430.70],[80,1.81,17260.15],
    [79,3.04,12036.46],[75,1.76,5088.63],[74,3.50,3154.69],
    [74,4.68,801.82],[70,0.83,9437.76],[62,3.98,8827.39],
    [61,1.82,7084.90],[57,2.78,6286.60],[56,4.39,14143.50],
    [56,3.47,6279.55],[52,0.19,12139.55],[52,1.33,1748.02],
    [51,0.28,5856.48],[49,0.49,1194.45],[41,5.37,8429.24],
    [41,2.40,19651.05],[39,6.17,10447.39],[37,6.04,10213.29],
    [37,2.57,1059.38],[36,1.71,2352.87],[36,1.78,6812.77],
    [33,0.59,17789.85],[30,0.44,83996.85],[30,2.74,1349.87],[25,3.16,4690.48]
  ];
  var VSOP_L1 = [
    [628331966747,0,0],[206059,2.678235,6283.07585],[4303,2.6351,12566.1517],
    [425,1.590,3.523],[119,5.796,26.298],[109,2.966,1577.344],
    [93,2.59,18849.23],[72,1.14,529.69],[68,1.87,398.15],
    [67,4.41,5507.55],[59,2.89,5223.69],[56,2.17,155.42],
    [45,0.40,796.30],[36,0.47,775.52],[29,2.65,7.11],
    [21,5.34,0.98],[19,1.85,5486.78],[19,4.97,213.30],
    [17,2.99,6275.96],[16,0.03,2544.31],[16,1.43,2146.17],
    [15,1.21,10977.08],[12,2.83,1748.02],[12,3.26,5088.63],
    [12,5.27,1194.45],[12,2.08,4694.00],[11,0.77,553.57],
    [10,1.30,6286.60],[10,4.24,1349.87],[9,2.70,242.73],
    [9,5.64,951.72],[8,5.30,2352.87],[6,2.65,9437.76],[6,4.67,4690.48]
  ];
  var VSOP_L2 = [
    [52919,0,0],[8720,1.0721,6283.0758],[309,0.867,12566.152],
    [27,0.05,3.52],[16,5.19,26.30],[16,3.68,155.42],
    [10,0.76,18849.23],[9,2.06,77713.77],[7,0.83,775.52],
    [5,4.66,1577.34],[4,1.03,7.11],[4,3.44,5573.14],
    [3,5.14,796.30],[3,6.05,5507.55],[3,1.19,242.73],
    [3,6.12,529.69],[3,0.31,398.15],[3,2.28,553.57],
    [2,4.38,5223.69],[2,3.75,0.98]
  ];
  var VSOP_L3 = [
    [289,5.844,6283.076],[35,0,0],[17,5.49,12566.15],
    [3,5.20,155.42],[1,4.72,3.52],[1,5.30,18849.23],[1,5.97,242.73]
  ];
  var VSOP_L4 = [[114,3.142,0],[8,4.13,6283.08],[1,3.84,12566.15]];

  function vsopSum(terms, tau) {
    var s = 0;
    for (var i = 0; i < terms.length; i++) s += terms[i][0] * Math.cos(terms[i][1] + terms[i][2] * tau);
    return s;
  }

  function sunLongitude(jde) {
    var T = (jde - 2451545) / 36525;
    var tau = T / 10;
    var L = (vsopSum(VSOP_L0, tau)
           + vsopSum(VSOP_L1, tau) * tau
           + vsopSum(VSOP_L2, tau) * tau * tau
           + vsopSum(VSOP_L3, tau) * tau * tau * tau
           + vsopSum(VSOP_L4, tau) * Math.pow(tau, 4)) / 1e8;   // 라디안
    var theta = norm360(L / D2R + 180);                          // 지구 황경 → 태양 황경
    var lambda = theta - 0.09033 / 3600;                         // VSOP87 → FK5
    var omega = 125.04 - 1934.136 * T;
    return norm360(lambda - 0.005692 - 0.00478 * sinD(omega));   // 광행차 + 장동
  }

  // 목표 황경(도)에 도달하는 시각(UT 율리우스일)을 seed 근처에서 찾는다.
  function solveSolarLongitude(target, seedJD) {
    var jd = seedJD;
    for (var i = 0; i < 12; i++) {
      var diff = norm360(target - sunLongitude(jdUTtoTT(jd)) + 180) - 180;
      jd += diff / 0.9856473;
      if (Math.abs(diff) < 1e-6) break;
    }
    return jd;
  }

  // 삭(new moon) 시각. k = 2000년 1월 6일 삭으로부터의 삭 번호. 반환은 UT.
  function newMoonJD(k) {
    var T = k / 1236.85;
    var jde = 2451550.09766 + 29.530588861 * k
            + 0.00015437 * T * T - 0.000000150 * T * T * T + 0.00000000073 * Math.pow(T, 4);
    var E  = 1 - 0.002516 * T - 0.0000074 * T * T;
    var M  = 2.5534 + 29.10535670 * k - 0.0000014 * T * T - 0.00000011 * T * T * T;
    var Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T * T * T - 0.000000058 * Math.pow(T, 4);
    var F  = 160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T * T * T + 0.000000011 * Math.pow(T, 4);
    var Om = 124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T * T * T;
    jde += -0.40720 * sinD(Mp)
         + 0.17241 * E * sinD(M)
         + 0.01608 * sinD(2 * Mp)
         + 0.01039 * sinD(2 * F)
         + 0.00739 * E * sinD(Mp - M)
         - 0.00514 * E * sinD(Mp + M)
         + 0.00208 * E * E * sinD(2 * M)
         - 0.00111 * sinD(Mp - 2 * F)
         - 0.00057 * sinD(Mp + 2 * F)
         + 0.00056 * E * sinD(2 * Mp + M)
         - 0.00042 * sinD(3 * Mp)
         + 0.00042 * E * sinD(M + 2 * F)
         + 0.00038 * E * sinD(M - 2 * F)
         - 0.00024 * E * sinD(2 * Mp - M)
         - 0.00017 * sinD(Om)
         - 0.00007 * sinD(Mp + 2 * M)
         + 0.00004 * sinD(2 * Mp - 2 * F)
         + 0.00004 * sinD(3 * M)
         + 0.00003 * sinD(Mp + M - 2 * F)
         + 0.00003 * sinD(2 * Mp + 2 * F)
         - 0.00003 * sinD(Mp + M + 2 * F)
         + 0.00003 * sinD(Mp - M + 2 * F)
         - 0.00002 * sinD(Mp - M - 2 * F)
         - 0.00002 * sinD(3 * Mp + M)
         + 0.00002 * sinD(4 * Mp);
    var A = [
      [299.77 + 0.107408 * k - 0.009173 * T * T, 0.000325],
      [251.88 + 0.016321 * k, 0.000165],
      [251.83 + 26.651886 * k, 0.000164],
      [349.42 + 36.412478 * k, 0.000126],
      [ 84.66 + 18.206239 * k, 0.000110],
      [141.74 + 53.303771 * k, 0.000062],
      [207.14 +  2.453732 * k, 0.000060],
      [154.84 +  7.306860 * k, 0.000056],
      [ 34.52 + 27.261239 * k, 0.000047],
      [207.19 +  0.121824 * k, 0.000042],
      [291.34 +  1.844379 * k, 0.000040],
      [161.72 + 24.198154 * k, 0.000037],
      [239.56 + 25.513099 * k, 0.000035],
      [331.55 +  3.592518 * k, 0.000023]
    ];
    for (var i = 0; i < A.length; i++) jde += A[i][1] * sinD(A[i][0]);
    return jde - deltaTSeconds(fromJD(jde).y) / 86400; // TT → UT
  }

  // ── 한국 시간대 역사 ────────────────────────────────────────────────────
  // 시주(時柱)는 시계 시각이 아니라 그 지점의 태양 위치로 정해진다. 그러려면
  // 먼저 시계 시각을 UTC로 되돌려야 하는데, 한국 표준시는 여러 번 바뀌었고
  // 서머타임도 있었다. 이걸 무시하면 1954~1961년생과 1987~88년생의 시주가
  // 통째로 한 칸 어긋난다.
  var TZ_HISTORY = [
    { until: [1908, 4, 1],  offset: 8.5 },   // 그 이전은 지방평시. 8.5로 근사.
    { until: [1912, 1, 1],  offset: 8.5 },
    { until: [1954, 3, 21], offset: 9 },
    { until: [1961, 8, 10], offset: 8.5 },
    { until: null,          offset: 9 }
  ];
  var DST_RANGES = [ // [시작 y,m,d,h, 끝 y,m,d,h] — 이 구간의 시계는 1시간 앞서 있었다
    [1948,6,1,0, 1948,9,13,0], [1949,4,3,0, 1949,9,11,0],
    [1950,4,1,0, 1950,9,10,0], [1951,5,6,0, 1951,9,9,0],
    [1955,5,5,0, 1955,9,9,0],  [1956,5,20,0, 1956,9,30,0],
    [1957,5,5,0, 1957,9,22,0], [1958,5,4,0, 1958,9,21,0],
    [1959,5,3,0, 1959,9,20,0], [1960,5,1,0, 1960,9,18,0],
    [1987,5,10,2, 1987,10,11,3], [1988,5,8,2, 1988,10,9,3]
  ];

  function ymdKey(y, m, d, h) { return ((y * 100 + m) * 100 + d) * 100 + (h || 0); }

  function standardOffset(y, m, d) {
    var key = ymdKey(y, m, d, 0);
    for (var i = 0; i < TZ_HISTORY.length; i++) {
      var u = TZ_HISTORY[i].until;
      if (!u || key < ymdKey(u[0], u[1], u[2], 0)) return TZ_HISTORY[i].offset;
    }
    return 9;
  }
  function inDST(y, m, d, h) {
    var key = ymdKey(y, m, d, h);
    for (var i = 0; i < DST_RANGES.length; i++) {
      var r = DST_RANGES[i];
      if (key >= ymdKey(r[0], r[1], r[2], r[3]) && key < ymdKey(r[4], r[5], r[6], r[7])) return true;
    }
    return false;
  }

  // 균시차(분). 시계가 가리키는 평균태양시와 실제 태양의 남중 시각 차이.
  function equationOfTime(jde) {
    var T = (jde - 2451545) / 36525;
    var L0 = norm360(280.4664567 + 360007.6982779 * (T / 10) + 0.03032028 * (T / 10) * (T / 10));
    var lambda = sunLongitude(jde);
    var eps = 23 + 26 / 60 + 21.448 / 3600
            - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
    var alpha = Math.atan2(cosD(eps) * sinD(lambda), cosD(lambda)) / D2R;
    var e = L0 - 0.0057183 - norm360(alpha);
    e = ((e + 180) % 360 + 360) % 360 - 180;
    return e * 4; // 도 → 분
  }

  // ── 사주 산출 ──────────────────────────────────────────────────────────
  var SOLAR_TERM_NAMES = ['입춘','경칩','청명','입하','망종','소서','입추','백로','한로','입동','대설','소한'];

  /**
   * @param {object} input
   *   year, month, day  : 양력 (시계 달력 그대로)
   *   hour, minute      : 시계 시각 24h. hour === null 이면 시주 없음
   *   longitude         : 출생지 경도(동경 +). 기본 126.98 (서울)
   *   useSolarTime      : 진태양시(경도+균시차) 보정 여부. 기본 true
   *   lateNightRule     : '야자시'(23시부터 다음날 일주) | '자정'(00시 기준)
   */
  function buildChart(input) {
    var y = input.year, mo = input.month, d = input.day;
    var hasHour = input.hour !== null && input.hour !== undefined;
    var h = hasHour ? input.hour : 12, mi = hasHour ? (input.minute || 0) : 0;
    var lon = typeof input.longitude === 'number' ? input.longitude : 126.98;
    var useSolar = input.useSolarTime !== false;
    var lateRule = input.lateNightRule || '야자시';

    var offset = standardOffset(y, mo, d);
    var dst = inDST(y, mo, d, h);
    var clockHours = h + mi / 60;
    var utJD = toJD(y, mo, d, clockHours - offset - (dst ? 1 : 0));

    // 절기·연주 판정은 실제 천문 시각(UT)으로 한다.
    var lambda = sunLongitude(jdUTtoTT(utJD));

    // 시주·일주 판정에 쓸 지방시
    var eot = useSolar ? equationOfTime(jdUTtoTT(utJD)) : 0;
    var localJD = utJD + (useSolar ? lon / 15 / 24 : offset / 24) + eot / 1440;
    // 분 단위로 맞춰 놓고 쓴다. 율리우스일은 실수라서 07:00 이 6.9999...로 나오는
    // 일이 있는데, 그대로 두면 시지가 통째로 한 칸 앞당겨진다.
    var local = fromJD(Math.round(localJD * 1440) / 1440 + 1e-9);
    var localHour = Math.round(local.hour * 60) / 60;
    if (localHour >= 24) localHour = 23 + 59 / 60;

    // 일주: 자시를 새 날의 시작으로 볼지(야자시) 자정으로 볼지에 따라 하루가 갈린다.
    var dayJDN = Math.floor(toJD(local.y, local.m, local.d, 12));
    if (lateRule === '야자시' && localHour >= 23) dayJDN += 1;
    var dayIdx = ((dayJDN + 49) % 60 + 60) % 60;
    var dayStem = dayIdx % 10, dayBranch = dayIdx % 12;

    // 연주: 입춘 전이면 전년도 간지
    var termYear = local.y;
    var ipchun = solveSolarLongitude(315, toJD(local.y, 2, 4, 0));
    if (utJD < ipchun) termYear -= 1;
    var yearStem = ((termYear - 4) % 10 + 10) % 10;
    var yearBranch = ((termYear - 4) % 12 + 12) % 12;

    // 월주: 태양 황경 315°(입춘=寅월)부터 30°씩
    var bucket = Math.floor(norm360(lambda - 315) / 30);
    var monthBranch = (2 + bucket) % 12;
    var monthStem = ((yearStem % 5) * 2 + 2 + bucket) % 10;

    // 시주
    var hourBranch = null, hourStem = null;
    if (hasHour) {
      hourBranch = Math.floor((localHour + 1) / 2) % 12;
      hourStem = ((dayStem % 5) * 2 + hourBranch) % 10;
    }

    var pillars = {
      year:  { stem: yearStem,  branch: yearBranch },
      month: { stem: monthStem, branch: monthBranch },
      day:   { stem: dayStem,   branch: dayBranch },
      hour:  hasHour ? { stem: hourStem, branch: hourBranch } : null
    };

    // 절기 경계와 얼마나 가까운가 — 가까우면 출생시각 오차가 사주를 바꾼다
    var termStart = solveSolarLongitude(norm360(315 + bucket * 30), utJD - 20);
    var termEnd   = solveSolarLongitude(norm360(315 + (bucket + 1) * 30), utJD + 5);
    var boundaryWarning = null;
    var toStart = (utJD - termStart) * 24, toEnd = (termEnd - utJD) * 24;
    if (toStart < 6 || toEnd < 6) {
      boundaryWarning = toStart < toEnd
        ? '절입(' + SOLAR_TERM_NAMES[bucket] + ') 직후 ' + toStart.toFixed(1) + '시간'
        : '다음 절입(' + SOLAR_TERM_NAMES[(bucket + 1) % 12] + ') ' + toEnd.toFixed(1) + '시간 전';
    }

    return {
      input: { year: y, month: mo, day: d, hour: hasHour ? h : null, minute: hasHour ? mi : null,
               gender: input.gender || null, longitude: lon },
      time: {
        standardOffset: offset, dst: dst,
        equationOfTime: useSolar ? Math.round(eot * 10) / 10 : 0,
        longitudeCorrection: useSolar ? Math.round((lon - offset * 15) * 4 * 10) / 10 : 0,
        localSolar: local, usedSolarTime: useSolar, lateNightRule: lateRule
      },
      pillars: pillars,
      termYear: termYear,
      solarLongitude: Math.round(lambda * 1000) / 1000,
      termName: SOLAR_TERM_NAMES[bucket],
      termStartJD: termStart, termEndJD: termEnd, birthJD: utJD,
      boundaryWarning: boundaryWarning
    };
  }

  // ── 십신 ───────────────────────────────────────────────────────────────
  function tenGod(dayStemIdx, targetElem, targetYang) {
    var me = STEM_ELEM[dayStemIdx], meYang = isYang(dayStemIdx);
    var same = meYang === targetYang;
    if (me === targetElem)            return same ? '비견' : '겁재';
    if (generates(me, targetElem))    return same ? '식신' : '상관';
    if (controls(me, targetElem))     return same ? '편재' : '정재';
    if (controls(targetElem, me))     return same ? '편관' : '정관';
    return same ? '편인' : '정인';
  }
  function tenGodOfStem(dayStemIdx, stemIdx) {
    return tenGod(dayStemIdx, STEM_ELEM[stemIdx], isYang(stemIdx));
  }
  function tenGodOfBranch(dayStemIdx, branchIdx) {
    var main = HIDDEN[branchIdx][HIDDEN[branchIdx].length - 1][0]; // 정기
    return tenGodOfStem(dayStemIdx, main);
  }

  // ── 신살 ───────────────────────────────────────────────────────────────
  var NOBLE = [[1,7],[0,8],[11,9],[11,9],[1,7],[0,8],[1,7],[2,6],[5,3],[5,3]]; // 천을귀인(일간별 지지)
  function triadKey(branch) { // 삼합 그룹: 0=인오술 1=신자진 2=사유축 3=해묘미
    if ([2,6,10].indexOf(branch) >= 0) return 0;
    if ([8,0,4].indexOf(branch) >= 0) return 1;
    if ([5,9,1].indexOf(branch) >= 0) return 2;
    return 3;
  }
  var DOHWA = [3,9,6,0], YEOKMA = [8,2,11,5], HWAGAE = [10,4,1,7];

  function findShinsal(chart) {
    var p = chart.pillars, out = [];
    var branches = [['연지',p.year.branch],['월지',p.month.branch],['일지',p.day.branch]];
    if (p.hour) branches.push(['시지', p.hour.branch]);
    var noble = NOBLE[p.day.stem];
    branches.forEach(function (b) {
      if (noble.indexOf(b[1]) >= 0) out.push({ name: '천을귀인', at: b[0], branch: BRANCH[b[1]] });
    });
    [p.year.branch, p.day.branch].forEach(function (base) {
      var k = triadKey(base);
      branches.forEach(function (b) {
        if (b[1] === DOHWA[k])  out.push({ name: '도화살', at: b[0], branch: BRANCH[b[1]] });
        if (b[1] === YEOKMA[k]) out.push({ name: '역마살', at: b[0], branch: BRANCH[b[1]] });
        if (b[1] === HWAGAE[k]) out.push({ name: '화개살', at: b[0], branch: BRANCH[b[1]] });
      });
    });
    // 중복 제거
    var seen = {}, uniq = [];
    out.forEach(function (s) {
      var k = s.name + s.at;
      if (!seen[k]) { seen[k] = 1; uniq.push(s); }
    });
    return uniq;
  }

  // (천간, 지지) → 60갑자 순번
  function sixtyIndex(stem, branch) {
    return stem + 10 * ((((branch - stem) % 12 + 12) % 12) / 2);
  }

  function gongmang(dayIdx) {
    var start = dayIdx - (dayIdx % 10);
    return [BRANCH[(start + 10) % 12], BRANCH[(start + 11) % 12]];
  }

  // ── 오행 분포 · 신강신약 · 용신 ─────────────────────────────────────────
  function analyze(chart) {
    var p = chart.pillars;
    var slots = [
      { pos: '연', stem: p.year.stem,  branch: p.year.branch,  w: 1 },
      { pos: '월', stem: p.month.stem, branch: p.month.branch, w: 1 },
      { pos: '일', stem: p.day.stem,   branch: p.day.branch,   w: 1 },
    ];
    if (p.hour) slots.push({ pos: '시', stem: p.hour.stem, branch: p.hour.branch, w: 1 });

    var count = { 목:0, 화:0, 토:0, 금:0, 수:0 };
    var weighted = { 목:0, 화:0, 토:0, 금:0, 수:0 };
    slots.forEach(function (s) {
      count[STEM_ELEM[s.stem]] += 1;
      count[BRANCH_ELEM[s.branch]] += 1;
      weighted[STEM_ELEM[s.stem]] += 1;
      // 지지는 지장간 배당일수 비율로 나눠 담는다 — 지지 하나를 오행 하나로만
      // 세면 진·술·축·미가 전부 토가 되어 실제 기운 분포를 크게 왜곡한다.
      var hid = HIDDEN[s.branch], total = 0;
      hid.forEach(function (x) { total += x[1]; });
      hid.forEach(function (x) { weighted[STEM_ELEM[x[0]]] += x[1] / total; });
    });
    Object.keys(weighted).forEach(function (k) { weighted[k] = Math.round(weighted[k] * 100) / 100; });

    var me = STEM_ELEM[p.day.stem];
    // 신강/신약: 월지에 가장 큰 가중치(득령), 일지·시지·천간 순.
    var support = 0, total = 0;
    function score(elem, w) {
      total += w;
      if (elem === me || generates(elem, me)) support += w;
    }
    score(STEM_ELEM[p.year.stem], 1);
    score(STEM_ELEM[p.month.stem], 1.5);
    score(BRANCH_ELEM[p.year.branch], 1);
    score(BRANCH_ELEM[p.month.branch], 3);   // 득령
    score(BRANCH_ELEM[p.day.branch], 2);     // 득지
    if (p.hour) { score(STEM_ELEM[p.hour.stem], 1); score(BRANCH_ELEM[p.hour.branch], 1.5); }
    var ratio = support / total;
    var strength = ratio >= 0.6 ? '신강' : ratio >= 0.45 ? '중화(신강 쪽)'
                 : ratio >= 0.35 ? '중화(신약 쪽)' : '신약';

    // 억부용신 — 강하면 덜어내고(식상·재·관), 약하면 보탠다(인성·비겁).
    // ELEMS 는 상생 순서(목→화→토→금→수→목)이므로
    //   +1 내가 생하는 것(식상), +2 내가 극하는 것(재),
    //   +3 나를 극하는 것(관),   +4 나를 생하는 것(인성)
    var idx = ELEMS.indexOf(me);
    var drain = [ELEMS[(idx + 1) % 5], ELEMS[(idx + 2) % 5], ELEMS[(idx + 3) % 5]];
    var boost = [ELEMS[(idx + 4) % 5], me];
    var candidates = ratio >= 0.5 ? drain : boost;

    // 조후 — 계절이 치우치면 억부보다 온도 조절이 급하다.
    var season = SEASON_OF_BRANCH[p.month.branch];
    var johu = null;
    if (season === '겨울') johu = '화';
    else if (season === '여름') johu = '수';
    var yongsin = candidates.slice();
    if (johu && candidates.indexOf(johu) >= 0) {
      yongsin = [johu].concat(candidates.filter(function (e) { return e !== johu; }));
    }

    var missing = ELEMS.filter(function (e) { return count[e] === 0; });
    var excess = ELEMS.filter(function (e) { return count[e] >= 4; });

    var tenGods = { stems: [], branches: [] };
    slots.forEach(function (s) {
      tenGods.stems.push({ pos: s.pos, god: s.pos === '일' ? '일간(나)' : tenGodOfStem(p.day.stem, s.stem) });
      tenGods.branches.push({ pos: s.pos, god: tenGodOfBranch(p.day.stem, s.branch) });
    });

    return {
      dayMaster: { stem: STEM[p.day.stem], hanja: STEM_H[p.day.stem], elem: me, yang: isYang(p.day.stem) },
      count: count, weighted: weighted, missing: missing, excess: excess,
      strength: strength, strengthRatio: Math.round(ratio * 100) / 100,
      season: season, johuNeed: johu,
      yongsin: yongsin, primaryYongsin: yongsin[0],
      tenGods: tenGods,
      gongmang: gongmang(sixtyIndex(p.day.stem, p.day.branch)),
      shinsal: findShinsal(chart)
    };
  }

  // ── 대운 ───────────────────────────────────────────────────────────────
  function buildLuckCycles(chart, gender) {
    var yearYang = isYang(chart.pillars.year.stem);
    var male = gender === '남';
    var forward = (yearYang && male) || (!yearYang && !male);

    var days = forward ? (chart.termEndJD - chart.birthJD) : (chart.birthJD - chart.termStartJD);
    var startAge = days / 3;                       // 3일 = 1년
    var luckNumber = Math.max(1, Math.round(startAge));

    var list = [];
    var ms = chart.pillars.month.stem, mb = chart.pillars.month.branch;
    for (var i = 1; i <= 10; i++) {
      var step = forward ? i : -i;
      var s = ((ms + step) % 10 + 10) % 10, b = ((mb + step) % 12 + 12) % 12;
      list.push({
        order: i,
        ageFrom: Math.round((startAge + (i - 1) * 10) * 10) / 10,
        ageTo: Math.round((startAge + i * 10) * 10) / 10,
        stem: STEM[s], branch: BRANCH[b], hanja: STEM_H[s] + BRANCH_H[b],
        elem: STEM_ELEM[s] + '/' + BRANCH_ELEM[b],
        tenGod: tenGodOfStem(chart.pillars.day.stem, s) + '/' + tenGodOfBranch(chart.pillars.day.stem, b)
      });
    }
    return {
      direction: forward ? '순행' : '역행',
      luckNumber: luckNumber,
      startAge: Math.round(startAge * 10) / 10,
      list: list
    };
  }

  function yearPillarOf(y) {
    var s = ((y - 4) % 10 + 10) % 10, b = ((y - 4) % 12 + 12) % 12;
    return { stem: STEM[s], branch: BRANCH[b], hanja: STEM_H[s] + BRANCH_H[b], stemIdx: s, branchIdx: b };
  }

  // ── 음력 ↔ 양력 ────────────────────────────────────────────────────────
  // 음력 표를 싣지 않고 삭(신월)과 중기(中氣)로 직접 만든다.
  //   · 동지가 든 달이 11월
  //   · 두 동지 사이에 13개 달이 있으면, 중기가 없는 첫 달이 윤달
  // 날짜 경계는 한국 표준시(+9) 자정 기준.
  function kstDayNumber(jd) { return Math.floor(jd + 9 / 24 + 0.5); }

  // 삭 순간이 아니라 "그 삭이 속한 KST 날짜"로 달의 경계를 잡는다. 달력의 하루는
  // 자정에 바뀌므로, 삭 시각으로 중기 포함 여부를 따지면 삭과 중기가 같은 날
  // 몇 시간 차이로 놓일 때 윤달이 한 달 밀린다(2020년 윤4월이 그런 경우다).
  function newMoonDay(k) { return kstDayNumber(newMoonJD(k)); }

  function lunationContaining(dayNum) {
    var k = Math.floor((dayNum - 0.5 - 9 / 24 - 2451550.09766) / 29.530588861);
    while (newMoonDay(k + 1) <= dayNum) k++;
    while (newMoonDay(k) > dayNum) k--;
    return k;
  }

  // KST 자정(그 날짜의 시작) 시점의 태양 황경
  function longitudeAtDayStart(dayNum) {
    return sunLongitude(jdUTtoTT(dayNum - 0.5 - 9 / 24));
  }

  // 동지(solarYear-1년 12월)가 든 달부터 다음 동지가 든 달 직전까지.
  // 반환: [{ startJDN, endJDN, num, leap, lunarYear }]  (num: 11,12,1,2,...,10)
  function lunarWindow(solarYear) {
    var ws1 = kstDayNumber(solveSolarLongitude(270, toJD(solarYear - 1, 12, 21, 0)));
    var ws2 = kstDayNumber(solveSolarLongitude(270, toJD(solarYear, 12, 21, 0)));
    var k1 = lunationContaining(ws1), k2 = lunationContaining(ws2);
    var n = k2 - k1;                       // 12 또는 13
    var starts = [];
    for (var i = 0; i <= n; i++) starts.push(newMoonDay(k1 + i));

    var leapIndex = -1;
    if (n === 13) {
      for (var j = 1; j <= n; j++) {
        // 중기(황경 30° 배수)가 이 달 안에 들어오지 않으면 윤달
        var la = longitudeAtDayStart(starts[j]), lb = longitudeAtDayStart(starts[j + 1]);
        var crossed = Math.floor(la / 30) !== Math.floor(lb / 30) || lb < la;
        if (!crossed) { leapIndex = j; break; }
      }
    }

    // 윤달은 바로 앞 달의 번호를 되풀이한다(윤4월은 4월 다음). leapIndex 는 결코
    // 0 이 아니므로(11월은 동지를 품어 반드시 중기가 있다) prev 는 항상 채워져 있다.
    var months = [], num = 11, ly = solarYear - 1, prevNum = 11, prevLy = ly;
    for (var i2 = 0; i2 < n; i2++) {
      var leap = (i2 === leapIndex);
      months.push({
        startJDN: starts[i2], endJDN: starts[i2 + 1] - 1,
        num: leap ? prevNum : num, leap: leap, lunarYear: leap ? prevLy : ly
      });
      if (!leap) {
        prevNum = num; prevLy = ly;
        num += 1;
        if (num === 13) { num = 1; ly += 1; }
      }
    }
    return months;
  }

  function solarToLunar(y, m, d) {
    var jdn = Math.floor(toJD(y, m, d, 12));
    var months = lunarWindow(y).concat(lunarWindow(y + 1));
    for (var i = 0; i < months.length; i++) {
      if (jdn >= months[i].startJDN && jdn <= months[i].endJDN) {
        return { year: months[i].lunarYear, month: months[i].num, leap: months[i].leap,
                 day: jdn - months[i].startJDN + 1 };
      }
    }
    return null;
  }

  function lunarToSolar(ly, lm, ld, isLeap) {
    // 음력 11·12월은 다음 양력 해의 창(窓)에 들어 있다.
    var months = lunarWindow(ly).concat(lunarWindow(ly + 1));
    for (var i = 0; i < months.length; i++) {
      var mm = months[i];
      if (mm.lunarYear === ly && mm.num === lm && !!mm.leap === !!isLeap) {
        var len = mm.endJDN - mm.startJDN + 1;
        if (ld > len) return { error: '해당 음력 달은 ' + len + '일까지입니다.' };
        var t = fromJD(mm.startJDN + ld - 1); // JDN 은 정오 기준 정수 — 그대로 쓰면 그 날짜
        return { year: t.y, month: t.m, day: t.d, monthLength: len };
      }
    }
    return { error: isLeap ? (ly + '년에는 윤' + lm + '월이 없습니다.') : '해당 음력 날짜를 찾지 못했습니다.' };
  }

  function leapMonthsOf(ly) {
    var months = lunarWindow(ly).concat(lunarWindow(ly + 1));
    return months.filter(function (m) { return m.leap && m.lunarYear === ly; })
                 .map(function (m) { return m.num; });
  }

  // ── 성명학 ─────────────────────────────────────────────────────────────
  var CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  var JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
  var JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

  // 한글 자모 획수(한글 획수법). 한자 획수법과 달리 한자 정보 없이 계산된다.
  var STROKE = {
    'ㄱ':1,'ㄲ':2,'ㄴ':1,'ㄷ':2,'ㄸ':4,'ㄹ':3,'ㅁ':3,'ㅂ':4,'ㅃ':8,'ㅅ':2,'ㅆ':4,
    'ㅇ':1,'ㅈ':2,'ㅉ':4,'ㅊ':3,'ㅋ':2,'ㅌ':3,'ㅍ':4,'ㅎ':3,
    'ㄳ':3,'ㄵ':3,'ㄶ':4,'ㄺ':4,'ㄻ':6,'ㄼ':7,'ㄽ':5,'ㄾ':6,'ㄿ':7,'ㅀ':6,'ㅄ':6,
    'ㅏ':2,'ㅐ':3,'ㅑ':3,'ㅒ':4,'ㅓ':2,'ㅔ':3,'ㅕ':3,'ㅖ':4,'ㅗ':2,'ㅘ':4,'ㅙ':5,
    'ㅚ':3,'ㅛ':3,'ㅜ':2,'ㅝ':4,'ㅞ':5,'ㅟ':3,'ㅠ':3,'ㅡ':1,'ㅢ':2,'ㅣ':1
  };
  // 발음오행(자음 오행)
  var CONSONANT_ELEM = {
    'ㄱ':'목','ㄲ':'목','ㅋ':'목',
    'ㄴ':'화','ㄷ':'화','ㄸ':'화','ㄹ':'화','ㅌ':'화',
    'ㅇ':'토','ㅎ':'토',
    'ㅅ':'금','ㅆ':'금','ㅈ':'금','ㅉ':'금','ㅊ':'금',
    'ㅁ':'수','ㅂ':'수','ㅃ':'수','ㅍ':'수'
  };

  function decomposeHangul(ch) {
    var code = ch.charCodeAt(0) - 0xAC00;
    if (code < 0 || code > 11171) return null;
    return { cho: CHO[Math.floor(code / 588)],
             jung: JUNG[Math.floor((code % 588) / 28)],
             jong: JONG[code % 28] };
  }

  function syllableInfo(ch) {
    var p = decomposeHangul(ch);
    if (!p) return null;
    var strokes = STROKE[p.cho] + STROKE[p.jung] + (p.jong ? STROKE[p.jong] : 0);
    return { ch: ch, cho: p.cho, jung: p.jung, jong: p.jong,
             strokes: strokes, elem: CONSONANT_ELEM[p.cho] || null };
  }

  // 81수리 — [등급, 이름]
  var SURI = {
    1:['대길','두령운'], 2:['흉','분리운'], 3:['대길','명예운'], 4:['흉','부정운'],
    5:['대길','성공운'], 6:['길','계승운'], 7:['길','독립운'], 8:['길','전진운'],
    9:['흉','궁박운'], 10:['흉','공허운'], 11:['대길','흥가운'], 12:['흉','박약운'],
    13:['대길','지모운'], 14:['흉','이산운'], 15:['대길','통솔운'], 16:['대길','덕망운'],
    17:['길','건창운'], 18:['길','발전운'], 19:['흉','고난운'], 20:['흉','허망운'],
    21:['대길','두령운'], 22:['흉','중절운'], 23:['대길','융창운'], 24:['대길','축재운'],
    25:['길','안강운'], 26:['흉','영웅시비운'], 27:['흉','중단운'], 28:['흉','파란운'],
    29:['길','성공운'], 30:['흉','부몽운'], 31:['대길','융창운'], 32:['길','순풍운'],
    33:['대길','승천운'], 34:['흉','파멸운'], 35:['길','평안운'], 36:['흉','파란운'],
    37:['길','인덕운'], 38:['중길','복덕운'], 39:['길','부영운'], 40:['흉','무상운'],
    41:['대길','대공운'], 42:['흉','고행운'], 43:['흉','산재운'], 44:['흉','마장운'],
    45:['길','대각운'], 46:['흉','비애운'], 47:['길','출세운'], 48:['길','유덕운'],
    49:['중길','은퇴운'], 50:['흉','부몽운'], 51:['중길','성쇠운'], 52:['길','약진운'],
    53:['흉','내허운'], 54:['흉','신고운'], 55:['흉','미달운'], 56:['흉','한탄운'],
    57:['길','노력운'], 58:['중길','후영운'], 59:['흉','실의운'], 60:['흉','동요운'],
    61:['길','영화운'], 62:['흉','고독운'], 63:['길','순성운'], 64:['흉','침체운'],
    65:['길','휘양운'], 66:['흉','우매운'], 67:['길','천복운'], 68:['길','명지운'],
    69:['흉','불안운'], 70:['흉','공허운'], 71:['중길','만달운'], 72:['흉','상반운'],
    73:['길','평길운'], 74:['흉','우매운'], 75:['중길','정수운'], 76:['흉','선곤운'],
    77:['중길','전후운'], 78:['중길','만고운'], 79:['흉','종극운'], 80:['흉','은둔운'],
    81:['대길','환원운']
  };
  function suriOf(n) {
    var v = n > 81 ? ((n - 1) % 81) + 1 : n;
    var e = SURI[v] || ['-','-'];
    return { number: n, reduced: v, grade: e[0], label: e[1] };
  }

  /**
   * 이름 분석. surname/given 은 한글, 한자는 선택(표기용).
   */
  function analyzeName(surname, given, opts) {
    opts = opts || {};
    var sChars = (surname || '').trim().split('').filter(function (c) { return decomposeHangul(c); });
    var gChars = (given || '').trim().split('').filter(function (c) { return decomposeHangul(c); });
    if (!sChars.length || !gChars.length) return null;

    var sInfo = sChars.map(syllableInfo), gInfo = gChars.map(syllableInfo);
    var all = sInfo.concat(gInfo);

    // 발음오행 배열 — 성에서 이름 끝으로 흐르는 방향까지 본다.
    // 앞 글자가 뒤 글자를 생하면 정생(가장 좋게 봄), 뒤가 앞을 생하면 역생,
    // 같으면 비화, 극하면 상극(방향에 따라 상극/역극)으로 나눈다.
    var FLOW_SCORE = { '상생': 100, '비화': 70, '역생': 60, '역극': 25, '상극': 15 };
    var flow = [];
    for (var i = 0; i < all.length - 1; i++) {
      var a = all[i].elem, b = all[i + 1].elem, rel;
      if (a === b) rel = '비화';
      else if (generates(a, b)) rel = '상생';
      else if (generates(b, a)) rel = '역생';
      else if (controls(a, b)) rel = '상극';
      else rel = '역극';
      flow.push({
        from: all[i].ch, to: all[i + 1].ch, fromElem: a, toElem: b,
        relation: rel, good: rel === '상생' || rel === '비화', score: FLOW_SCORE[rel]
      });
    }
    var flowScore = flow.length
      ? Math.round(flow.reduce(function (acc, f) { return acc + f.score; }, 0) / flow.length)
      : 100;

    // 사격(四格) — 한글 획수 기준. 이름이 한 글자면 가상수 1 을 더한다.
    var sStroke = sInfo.reduce(function (a, x) { return a + x.strokes; }, 0);
    var gStrokes = gInfo.map(function (x) { return x.strokes; });
    var gTotal = gStrokes.reduce(function (a, b) { return a + b; }, 0);
    var virtual = gStrokes.length === 1;
    var won = virtual ? gTotal + 1 : gTotal;
    var hyeong = sStroke + gStrokes[0];
    var i2 = virtual ? sStroke + 1 : sStroke + gStrokes[gStrokes.length - 1];
    var jeong = sStroke + gTotal;

    var frames = [
      { key: '원격', num: won,    period: '초년(0~20세)',  suri: suriOf(won) },
      { key: '형격', num: hyeong, period: '청년(21~40세)', suri: suriOf(hyeong) },
      { key: '이격', num: i2,     period: '중년(41~60세)', suri: suriOf(i2) },
      { key: '정격', num: jeong,  period: '말년·총운',     suri: suriOf(jeong) }
    ];
    var gradeScore = { '대길': 100, '길': 80, '중길': 60, '흉': 25 };
    var suriScore = Math.round(frames.reduce(function (a, f) {
      return a + (gradeScore[f.suri.grade] || 50);
    }, 0) / frames.length);

    // 이름이 사주에 필요한 오행을 채워주는가
    var nameElems = all.map(function (x) { return x.elem; });
    var supply = {};
    nameElems.forEach(function (e) { supply[e] = (supply[e] || 0) + 1; });
    var match = null;
    if (opts.yongsin && opts.yongsin.length) {
      var primary = opts.yongsin[0];
      var hasPrimary = nameElems.indexOf(primary) >= 0;
      var hasAny = opts.yongsin.some(function (e) { return nameElems.indexOf(e) >= 0; });
      match = {
        yongsin: opts.yongsin, primary: primary,
        hasPrimary: hasPrimary, hasAny: hasAny,
        score: hasPrimary ? 100 : hasAny ? 65 : 20,
        fillsMissing: (opts.missing || []).filter(function (e) { return nameElems.indexOf(e) >= 0; }),
        addsExcess: (opts.excess || []).filter(function (e) { return nameElems.indexOf(e) >= 0; })
      };
    }

    var parts = [flowScore, suriScore];
    if (match) parts.push(match.score);
    var totalScore = Math.round(parts.reduce(function (a, b) { return a + b; }, 0) / parts.length);

    return {
      surname: surname, given: given, hanja: opts.hanja || null,
      syllables: all.map(function (x) {
        return { ch: x.ch, cho: x.cho, strokes: x.strokes, elem: x.elem, elemHanja: ELEM_H[x.elem] };
      }),
      soundFlow: flow, flowScore: flowScore,
      strokes: { surname: sStroke, given: gStrokes, total: sStroke + gTotal, virtualNumberUsed: virtual },
      frames: frames, suriScore: suriScore,
      elemSupply: supply, sajuMatch: match,
      totalScore: totalScore
    };
  }

  // ── 지지·천간 관계 ──────────────────────────────────────────────────────
  var YUKHAP  = [[0,1],[2,11],[3,10],[4,9],[5,8],[6,7]];            // 육합
  var SAMHAP  = [[2,6,10],[8,0,4],[5,9,1],[11,3,7]];                // 삼합
  var BANGHAP = [[2,3,4],[5,6,7],[8,9,10],[11,0,1]];                // 방합
  var HYEONG3 = [[2,5,8],[1,10,7]];                                 // 삼형
  var HYEONG2 = [[0,3]];                                            // 상형(자묘)
  var JAHYEONG = [4,6,9,11];                                        // 자형(진오유해)
  var YUKHAE  = [[0,7],[1,6],[2,5],[3,4],[8,11],[9,10]];            // 육해
  var PA      = [[0,9],[1,4],[2,11],[3,6],[5,8],[7,10]];            // 파
  var WONJIN  = [[0,7],[1,6],[2,9],[3,8],[4,11],[5,10]];            // 원진

  function hasPair(list, a, b) {
    for (var i = 0; i < list.length; i++) {
      if ((list[i][0] === a && list[i][1] === b) || (list[i][0] === b && list[i][1] === a)) return true;
    }
    return false;
  }
  function inTriad(list, a, b) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].indexOf(a) >= 0 && list[i].indexOf(b) >= 0) return true;
    }
    return false;
  }

  // 두 지지 사이에 성립하는 관계들. delta 는 길(+)·흉(-) 방향의 기본 크기.
  function branchRelations(a, b) {
    var out = [];
    if (a === b && JAHYEONG.indexOf(a) >= 0) out.push({ name: '자형', delta: -1.0 });
    if (Math.abs(a - b) === 6) out.push({ name: '충', delta: -2.0 });
    if (hasPair(YUKHAP, a, b)) out.push({ name: '육합', delta: 1.2 });
    if (a !== b && inTriad(SAMHAP, a, b)) out.push({ name: '삼합', delta: 1.0 });
    if (a !== b && inTriad(BANGHAP, a, b)) out.push({ name: '방합', delta: 0.6 });
    if (a !== b && (inTriad(HYEONG3, a, b) || hasPair(HYEONG2, a, b))) out.push({ name: '형', delta: -1.2 });
    if (hasPair(YUKHAE, a, b)) out.push({ name: '해', delta: -0.6 });
    if (hasPair(PA, a, b)) out.push({ name: '파', delta: -0.5 });
    if (hasPair(WONJIN, a, b)) out.push({ name: '원진', delta: -0.8 });
    return out;
  }
  function stemRelation(a, b) {
    if (Math.abs(a - b) === 5) return { name: '천간합', delta: 0.8 };
    if (Math.abs(a - b) === 6 && Math.min(a, b) <= 3) return { name: '천간충', delta: -1.0 };
    return null;
  }

  // ── 영역별 운세 점수 ────────────────────────────────────────────────────
  //
  // 세운(그 해의 간지)과 대운(10년 배경)이 원국에 어떻게 얹히는지를 세 영역으로
  // 나눠 점수화한다. 표의 두 값은 [일간이 강할 때, 약할 때] 이다. 같은 재성이라도
  // 신강한 사람에게는 벌이가 되고 신약한 사람에게는 짐이 되기 때문에, 십신 하나에
  // 점수 하나를 박아 두면 절반은 거꾸로 읽힌다.
  //
  // 이 표는 계산이 아니라 해석이다. 널리 쓰이는 억부 관점을 수치로 옮긴 것이고,
  // 유파에 따라 다르게 볼 수 있다.
  var DOMAIN_TABLE = {
    // 신약 열에서 인성을 재물의 최상위로 두면 안 된다. 신약한 사람에게 인성운은
    // 기댈 곳이 생기는 안정이지 수입이 늘어나는 해가 아니고, 겁재는 신약이어도
    // 재물에서만큼은 남의 손이다. 그래서 건강 쪽 인비 점수보다 낮게 잡는다.
    money: {
      정재: [3.0, -0.3], 편재: [2.6, -0.6], 식신: [2.2, -0.6], 상관: [1.6, -1.0],
      정관: [1.0, -1.5], 편관: [0.3, -2.0], 정인: [-0.8, 1.5], 편인: [-1.0, 1.1],
      비견: [-1.2, 1.6], 겁재: [-2.2, 0.6]
    },
    health: {
      정재: [0.3, -1.2], 편재: [0.2, -1.4], 식신: [0.8, -1.0], 상관: [-0.3, -1.6],
      정관: [0.3, -1.6], 편관: [-1.2, -2.4], 정인: [0.8, 2.4], 편인: [0.2, 1.8],
      비견: [0.5, 2.2], 겁재: [-0.2, 1.8]
    },
    relation: {
      정재: [2.0, 0.3], 편재: [1.2, -0.3], 식신: [1.4, 0.2], 상관: [-1.6, -2.0],
      정관: [2.6, 1.0], 편관: [0.2, -1.8], 정인: [1.6, 2.0], 편인: [-0.5, 0.8],
      비견: [0.4, 1.4], 겁재: [-1.4, 0.4]
    }
  };
  // 지지 형충회합을 영역별로 얼마나 무겁게 볼지. 인연은 합충에 가장 민감하다.
  var REL_WEIGHT = { money: 0.9, health: 1.2, relation: 1.4 };
  // 용신·기신(오행 균형)을 영역별로 얼마나 무겁게 볼지. 건강은 일간의 균형
  // 자체가 주제라 가장 크게 걸리고, 재물은 균형보다 재성·식상이 오는지가 먼저다.
  // 이 가중치가 없으면 세 영역이 전부 용신 하나를 따라가 같은 답을 낸다.
  var ELEM_WEIGHT = { money: 0.55, health: 1.35, relation: 0.8 };
  var DOMAIN_LABEL = { money: '재물', health: '건강', relation: '관계' };

  /**
   * 해마다 세 영역의 점수를 매기고, 좋은 시기·나쁜 시기를 뽑는다.
   * @param {object} reading  fullReading() 결과
   * @param {object} opts     { fromAge, toAge } 순위를 매길 나이 구간
   */
  function fortuneTimeline(reading, opts) {
    opts = opts || {};
    var an = reading.analysis, pil = reading.chart.pillars;
    var dayStem = pil.day.stem;
    var strong = an.strengthRatio >= 0.5;
    var si = strong ? 0 : 1;

    var yongPrimary = an.yongsin[0];
    var yi = ELEMS.indexOf(yongPrimary);
    var huisin = ELEMS[(yi + 4) % 5];   // 용신을 생하는 오행
    var gisin  = ELEMS[(yi + 3) % 5];   // 용신을 극하는 오행

    var natalBranches = [
      { pos: '연지', b: pil.year.branch, w: 0.8 },
      { pos: '월지', b: pil.month.branch, w: 1.2 },
      { pos: '일지', b: pil.day.branch, w: 1.5 }   // 일지는 나 자신의 자리
    ];
    if (pil.hour) natalBranches.push({ pos: '시지', b: pil.hour.branch, w: 0.9 });

    var gongmangSet = an.gongmang;

    function elemBonus(elem, weight) {
      if (elem === yongPrimary) return { d: 2.0 * weight, why: '용신 ' + elem };
      if (an.yongsin.indexOf(elem) > 0) return { d: 1.2 * weight, why: '희용신 ' + elem };
      if (elem === huisin) return { d: 0.7 * weight, why: elem + '이 용신을 도움' };
      if (elem === gisin) return { d: -1.4 * weight, why: '기신 ' + elem };
      return null;
    }

    var birthYear = reading.solar.year;
    var years = [];

    for (var age = 0; age <= 90; age++) {
      var Y = birthYear + age;
      var seun = yearPillarOf(Y);
      var luck = null;
      for (var li = 0; li < reading.luck.list.length; li++) {
        var L = reading.luck.list[li];
        if (age >= L.ageFrom && age < L.ageTo) { luck = L; break; }
      }
      var luckStem = luck ? STEM.indexOf(luck.stem) : null;
      var luckBranch = luck ? BRANCH.indexOf(luck.branch) : null;

      // 그 해에 작용하는 기운들: 세운이 앞이고 대운은 배경이다.
      var sources = [
        { tag: '세운 천간', stem: seun.stemIdx, w: 1.0 },
        { tag: '세운 지지', branch: seun.branchIdx, w: 1.2 }
      ];
      if (luck) {
        sources.push({ tag: '대운 천간', stem: luckStem, w: 0.6 });
        sources.push({ tag: '대운 지지', branch: luckBranch, w: 0.8 });
      }

      var raw = { money: 0, health: 0, relation: 0 };
      var factors = { money: [], health: [], relation: [] };

      function add(domain, delta, label) {
        if (!delta) return;
        raw[domain] += delta;
        factors[domain].push({ label: label, delta: Math.round(delta * 100) / 100 });
      }

      sources.forEach(function (src) {
        var god, elem;
        if (src.stem !== undefined) {
          god = tenGodOfStem(dayStem, src.stem);
          elem = STEM_ELEM[src.stem];
        } else {
          god = tenGodOfBranch(dayStem, src.branch);
          elem = BRANCH_ELEM[src.branch];
        }
        Object.keys(DOMAIN_TABLE).forEach(function (dom) {
          add(dom, DOMAIN_TABLE[dom][god][si] * src.w, src.tag + ' ' + god);
        });
        var eb = elemBonus(elem, src.w);
        if (eb) Object.keys(raw).forEach(function (dom) {
          add(dom, eb.d * ELEM_WEIGHT[dom], src.tag + ' — ' + eb.why);
        });
      });

      // 영역마다 고유하게 걸리는 신호들
      var seunStemGod = tenGodOfStem(dayStem, seun.stemIdx);
      var seunBranchGod = tenGodOfBranch(dayStem, seun.branchIdx);
      var isSiksang = function (g) { return g === '식신' || g === '상관'; };
      var isJae = function (g) { return g === '정재' || g === '편재'; };

      // 재물 — 식상이 재를 생하는 해(식상생재). 벌이가 성과로 이어지는 배치다.
      if ((isSiksang(seunStemGod) && isJae(seunBranchGod)) ||
          (isJae(seunStemGod) && isSiksang(seunBranchGod))) {
        add('money', strong ? 1.4 : -0.6, '세운에 식상생재' + (strong ? '' : '(신약이라 부담)'));
      }
      // 재물 — 비겁이 겹쳐 오면 남의 손이 들어온다(군겁쟁재).
      if (strong && (seunStemGod === '겁재' || seunStemGod === '비견') &&
          (seunBranchGod === '겁재' || seunBranchGod === '비견')) {
        add('money', -1.4, '세운 천간·지지가 모두 비겁(군겁쟁재)');
      }
      // 관계 — 배우자 자리인 일지와 합하는 해
      if (hasPair(YUKHAP, seun.branchIdx, pil.day.branch)) {
        add('relation', 0.8, '일지(배우자 자리)와 육합');
      }
      // 관계 — 도화가 드는 해는 사람이 모이고 눈에 띈다.
      var dohwaBranches = [triadKey(pil.year.branch), triadKey(pil.day.branch)]
        .map(function (k) { return DOHWA[k]; });
      if (dohwaBranches.indexOf(seun.branchIdx) >= 0) add('relation', 0.9, '세운에 도화');
      // 건강 — 천간·지지가 모두 기신이면 한 해 내내 같은 방향으로 눌린다.
      if (STEM_ELEM[seun.stemIdx] === gisin && BRANCH_ELEM[seun.branchIdx] === gisin) {
        add('health', -1.0, '세운 천간·지지가 모두 기신 ' + gisin);
      }
      // 건강 — 편관이 세운·대운에 겹치면 몸이 먼저 반응한다.
      if (luck && seunStemGod === '편관' && tenGodOfStem(dayStem, luckStem) === '편관') {
        add('health', -1.0, '세운·대운 편관이 겹침');
      }

      // 세운 지지가 원국 지지와 맺는 관계
      natalBranches.forEach(function (nb) {
        branchRelations(seun.branchIdx, nb.b).forEach(function (rel) {
          Object.keys(raw).forEach(function (dom) {
            add(dom, rel.delta * nb.w * REL_WEIGHT[dom], nb.pos + ' ' + rel.name);
          });
        });
      });
      // 세운 천간과 일간의 관계
      var sr = stemRelation(seun.stemIdx, dayStem);
      if (sr) Object.keys(raw).forEach(function (dom) { add(dom, sr.delta * REL_WEIGHT[dom], '일간과 ' + sr.name); });

      // 공망이 든 해는 무슨 기운이 와도 손에 잘 안 잡힌다 — 크기를 줄인다.
      var isGongmang = gongmangSet.indexOf(BRANCH[seun.branchIdx]) >= 0;
      if (isGongmang) {
        Object.keys(raw).forEach(function (dom) {
          raw[dom] *= 0.85;
          factors[dom].push({ label: '세운 지지가 공망(' + BRANCH[seun.branchIdx] + ')', delta: 0 });
        });
      }

      years.push({
        year: Y, age: age,
        seun: seun.hanja, seunKor: seun.stem + seun.branch,
        daeun: luck ? luck.hanja : null,
        gongmang: isGongmang,
        raw: raw, factors: factors
      });
    }

    // 0~100 으로 환산 — 이 사람의 일생 안에서의 상대 비교다.
    ['money', 'health', 'relation'].forEach(function (dom) {
      var vals = years.map(function (y) { return y.raw[dom]; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var span = hi - lo || 1;
      years.forEach(function (y) {
        y[dom] = Math.round((y.raw[dom] - lo) / span * 100);
      });
    });

    var fromAge = typeof opts.fromAge === 'number' ? opts.fromAge : 18;
    var toAge = typeof opts.toAge === 'number' ? opts.toAge : 90;
    var window_ = years.filter(function (y) { return y.age >= fromAge && y.age <= toAge; });

    var result = { years: years, window: { fromAge: fromAge, toAge: toAge }, domains: {} };
    ['money', 'health', 'relation'].forEach(function (dom) {
      result.domains[dom] = {
        label: DOMAIN_LABEL[dom],
        best: pickPeriods(window_, dom, 1, 3),
        worst: pickPeriods(window_, dom, -1, 3)
      };
    });
    result.basis = {
      strength: an.strength, strong: strong,
      yongsin: an.yongsin, huisin: huisin, gisin: gisin
    };
    return result;
  }

  // 점수가 높은(낮은) 해를 고른 뒤 이웃한 해로 넓혀 하나의 "시기"로 묶는다.
  // 연속한 세 해가 모두 좋은데 세 줄로 따로 세우면 시기가 아니라 목록이 된다.
  function pickPeriods(list, dom, dir, count) {
    if (!list.length) return [];
    var sorted = list.slice().sort(function (a, b) { return (b[dom] - a[dom]) * dir; });
    var scores = list.map(function (y) { return y[dom]; }).slice().sort(function (a, b) { return a - b; });
    var q = function (p) { return scores[Math.min(scores.length - 1, Math.floor(scores.length * p))]; };
    var band = dir > 0 ? q(0.65) : q(0.35);

    var used = {}, byYear = {};
    list.forEach(function (y) { byYear[y.year] = y; });

    // 같은 지지가 도는 해는 12년마다 같은 이유로 다시 걸린다(일지 충이 대표적).
    // 그대로 두면 庚戌·壬戌·甲戌 세 줄이 나와, 한 가지 사실을 세 번 말하게 된다.
    // 그래서 1차로는 지지가 겹치지 않는 시기만 고르고, 그러고도 개수가 모자랄
    // 때만 2차로 중복을 허용한다.
    var out = [], seenBranch = {};
    for (var pass = 0; pass < 2 && out.length < count; pass++) {
    for (var i = 0; i < sorted.length && out.length < count; i++) {
      var peak = sorted[i];
      if (used[peak.year]) continue;
      var pb = peak.seun.charAt(1);
      if (pass === 0 && seenBranch[pb]) continue;
      seenBranch[pb] = true;
      var from = peak.year, to = peak.year;
      var inBand = function (y) { return y && !used[y.year] && (dir > 0 ? y[dom] >= band : y[dom] <= band); };
      while (to - from < 4 && inBand(byYear[from - 1])) from--;
      while (to - from < 4 && inBand(byYear[to + 1])) to++;
      for (var y2 = from; y2 <= to; y2++) used[y2] = true;

      var members = [];
      for (var y3 = from; y3 <= to; y3++) if (byYear[y3]) members.push(byYear[y3]);
      var mean = members.reduce(function (a, m) { return a + m[dom]; }, 0) / members.length;

      // 왜 이 시기인지 — 정점 해에서 그 방향으로 가장 크게 작용한 항목들.
      // 좋은 시기에 감점 요인을, 나쁜 시기에 가점 요인을 섞어 보여 주면
      // 근거가 아니라 소음이 된다.
      var reasons = peak.factors[dom]
        .filter(function (f) { return dir > 0 ? f.delta >= 0.4 : f.delta <= -0.4; })
        .sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); })
        .slice(0, 3)
        .map(function (f) { return f.label; });
      if (peak.gongmang && dir < 0) reasons.push('세운 지지가 공망');

      out.push({
        fromYear: from, toYear: to,
        fromAge: byYear[from].age, toAge: byYear[to].age,
        peakYear: peak.year, peakAge: peak.age,
        score: peak[dom], meanScore: Math.round(mean),
        peakSeun: peak.seun, peakSeunKor: peak.seunKor, daeun: peak.daeun,
        reasons: reasons
      });
    }
    }
    out.sort(function (a, b) { return (b.score - a.score) * dir; });
    return out;
  }

  // ── 궁합 ────────────────────────────────────────────────────────────────
  //
  // 두 사람의 원국을 네 축으로 견준다. 총점 하나만 던지면 "왜"가 사라지고,
  // 84점과 61점의 차이가 무엇인지 아무도 알 수 없다. 그래서 축마다 어떤 항목이
  // 몇 점을 더하고 뺐는지 그대로 들고 나간다.
  //
  //   끌림  — 일간·일지가 서로 당기는가 (합충)
  //   안정  — 서로 모자란 오행을 채워 주는가, 힘의 세기가 맞물리는가
  //   소통  — 상대가 나에게 어떤 십신인가, 이름의 소리가 어울리는가
  //   지속  — 오래 두었을 때 갈리는 자리(충·형·해·파·원진)가 얼마나 있는가
  //
  // 축 점수는 50에서 시작해 항목을 더하고 뺀 뒤 0~100으로 자른다.
  var COMPAT_AXES = ['attraction', 'stability', 'communication', 'endurance'];
  var COMPAT_LABEL = {
    attraction: '끌림', stability: '안정', communication: '소통', endurance: '지속'
  };
  var COMPAT_WEIGHT = { attraction: 0.3, stability: 0.28, communication: 0.22, endurance: 0.2 };

  // 축 점수를 가중평균한 원점수는 대개 45~70 사이에 몰린다. 그 숫자를 그대로
  // "궁합 56점"이라고 내놓으면 누구와 붙여도 비슷비슷해 보여서 비교가 안 된다.
  // 그래서 무작위로 짝지은 48,180쌍의 원점수 분포(5% 간격 분위값)에 견주어
  // 백분위로 환산한다. 환산 점수 70이면 "무작위로 만난 상대 100명 중 상위 30번째"
  // 라는 뜻이지, 100점 만점에 70점이라는 뜻이 아니다.
  var COMPAT_BASELINE = [29, 45, 48, 50, 52, 53, 54, 55, 56, 57, 57,
                         58, 59, 60, 61, 62, 63, 64, 66, 68, 80];
  function compatPercentile(raw) {
    if (raw <= COMPAT_BASELINE[0]) return 0;
    for (var i = 0; i < COMPAT_BASELINE.length - 1; i++) {
      var lo = COMPAT_BASELINE[i], hi = COMPAT_BASELINE[i + 1];
      if (raw <= hi) {
        var t = hi === lo ? 0 : (raw - lo) / (hi - lo);
        return Math.max(0, Math.min(100, Math.round((i + t) * 5)));
      }
    }
    return 100;
  }

  // 상대 일간이 나에게 어떤 십신인지에 따른 소통 점수.
  // 정(正) 계열은 결이 맞고, 편(偏) 계열은 자극이 크되 마찰도 크다.
  var COMPAT_GOD_SCORE = {
    정관: 9, 정인: 9, 정재: 8, 식신: 8, 비견: 4,
    편재: 3, 편인: -2, 겁재: -4, 편관: -6, 상관: -8
  };

  // 받침 유무에 따라 조사를 고른다. "용신 수이 들어 있음" 같은 문장을 막는다.
  function josa(word, pair) {
    var parts = pair.split('/');
    if (!word) return '';
    var code = word.charCodeAt(word.length - 1) - 0xAC00;
    var hasBatchim = code >= 0 && code <= 11171 && (code % 28) !== 0;
    return word + (hasBatchim ? parts[0] : parts[1]);
  }

  function elementCount(reading) {
    return reading.analysis.weighted;
  }

  function compatibility(A, B, opts) {
    opts = opts || {};
    var pa = A.chart.pillars, pb = B.chart.pillars;
    var axes = {};
    COMPAT_AXES.forEach(function (k) { axes[k] = { score: 50, items: [] }; });
    function add(axis, delta, label) {
      if (!delta) return;
      axes[axis].score += delta;
      axes[axis].items.push({ label: label, delta: Math.round(delta * 10) / 10 });
    }

    // ── 일간끼리 ──
    var sa = pa.day.stem, sb = pb.day.stem;
    var stemRel = stemRelation(sa, sb);
    var ea = STEM_ELEM[sa], eb = STEM_ELEM[sb];
    if (stemRel && stemRel.name === '천간합') {
      add('attraction', 22, '일간 ' + STEM[sa] + '·' + STEM[sb] + ' 천간합 — 서로에게 끌리는 자리');
      add('endurance', 8, '일간이 합을 이룸');
    } else if (stemRel && stemRel.name === '천간충') {
      add('attraction', -10, '일간 ' + STEM[sa] + '·' + STEM[sb] + ' 천간충 — 첫인상부터 부딪힘');
      add('endurance', -12, '일간이 충함');
    }
    if (ea === eb) {
      add('communication', 6, '일간이 같은 ' + ea + ' — 말이 잘 통함');
      add('attraction', -4, '같은 오행이라 자극은 덜함');
    } else if (generates(ea, eb)) {
      add('communication', 7, ea + '이 ' + eb + '을 생함 — 내가 주는 쪽');
      add('stability', 5, '한쪽이 기운을 대 줌');
    } else if (generates(eb, ea)) {
      add('communication', 7, eb + '이 ' + ea + '을 생함 — 상대가 주는 쪽');
      add('stability', 5, '한쪽이 기운을 대 줌');
    } else if (controls(ea, eb) || controls(eb, ea)) {
      add('attraction', 6, ea + '과 ' + eb + '이 극 — 긴장감이 있는 조합');
      add('communication', -6, '오행이 서로 극함');
      add('endurance', -5, '오래 두면 눌리는 쪽이 생김');
    }
    var godBtoA = tenGodOfStem(sa, sb);   // 상대가 나에게
    var godAtoB = tenGodOfStem(sb, sa);   // 내가 상대에게
    add('communication', (COMPAT_GOD_SCORE[godBtoA] || 0) * 0.8, '상대는 나에게 ' + godBtoA);
    add('communication', (COMPAT_GOD_SCORE[godAtoB] || 0) * 0.8, '나는 상대에게 ' + godAtoB);

    // ── 일지끼리 (배우자궁) ──
    var ba = pa.day.branch, bb = pb.day.branch;
    branchRelations(ba, bb).forEach(function (rel) {
      var w = { 육합: [20, 10], 삼합: [15, 8], 방합: [8, 4],
                충: [-16, -18], 형: [-8, -12], 해: [-4, -7], 파: [-3, -5],
                원진: [-6, -10], 자형: [-4, -6] }[rel.name];
      if (!w) return;
      add('attraction', w[0], '일지(배우자 자리) ' + BRANCH[ba] + '·' + BRANCH[bb] + ' ' + rel.name);
      add('endurance', w[1], '일지 ' + rel.name);
    });

    // ── 연지끼리 (띠 궁합) ──
    var za = pa.year.branch, zb = pb.year.branch;
    branchRelations(za, zb).forEach(function (rel) {
      var w = { 육합: 8, 삼합: 7, 방합: 3, 충: -7, 형: -4, 해: -2, 파: -2, 원진: -6, 자형: -2 }[rel.name];
      if (!w) return;
      add('endurance', w, '띠(연지) ' + BRANCH_ANIMAL[za] + '·' + BRANCH_ANIMAL[zb] + ' ' + rel.name);
    });

    // ── 오행 보완 ──
    // 상대가 내 용신 오행을 얼마나 들고 있는가. 서로 채워 주면 함께 있을수록 편해진다.
    function supply(me, other) {
      var have = elementCount(other), y = me.analysis.yongsin;
      var s = 0;
      if (y[0] && have[y[0]] >= 1.5) s += 12;
      else if (y[0] && have[y[0]] >= 0.8) s += 6;
      if (y[1] && have[y[1]] >= 1.5) s += 5;
      (me.analysis.missing || []).forEach(function (m) { if (have[m] >= 1) s += 4; });
      var gi = ELEMS[(ELEMS.indexOf(y[0]) + 3) % 5];
      if (have[gi] >= 3) s -= 7;
      return s;
    }
    var supAB = supply(A, B), supBA = supply(B, A);
    add('stability', supAB * 0.6, supAB >= 0
      ? '상대가 내 용신(' + A.analysis.yongsin[0] + ')을 채워 줌'
      : '상대에게 내 기신이 많음');
    add('stability', supBA * 0.6, supBA >= 0
      ? '내가 상대의 용신(' + B.analysis.yongsin[0] + ')을 채워 줌'
      : '나에게 상대의 기신이 많음');

    // ── 힘의 세기 조합 ──
    var stA = A.analysis.strengthRatio >= 0.5, stB = B.analysis.strengthRatio >= 0.5;
    if (stA && stB) {
      add('stability', -8, '둘 다 일간이 강함 — 서로 물러서지 않는 조합');
      add('endurance', -5, '주도권이 겹침');
    } else if (!stA && !stB) {
      add('stability', -3, '둘 다 일간이 약함 — 기댈 곳이 서로뿐');
    } else {
      add('stability', 9, '한쪽이 강하고 한쪽이 약함 — 역할이 갈림');
    }

    // ── 조후 (계절 균형) ──
    var seasonA = A.analysis.season, seasonB = B.analysis.season;
    if ((seasonA === '여름' && seasonB === '겨울') || (seasonA === '겨울' && seasonB === '여름')) {
      add('stability', 8, '여름생과 겨울생 — 온도가 서로 맞춰짐');
    } else if (seasonA === seasonB && (seasonA === '여름' || seasonA === '겨울')) {
      add('stability', -6, '둘 다 ' + seasonA + '생 — 한쪽으로 치우침');
    }

    // ── 이름 ──
    var nameNote = null;
    if (A.name && B.name) {
      // 이름을 이어 부르는 소리는 양쪽 순서를 다 본다. 한쪽 순서만 보면 같은 두
      // 사람인데도 누가 먼저 여느냐에 따라 점수가 달라진다(궁합은 짝의 성질이지
      // 묻는 사람의 성질이 아니다).
      var soundPair = function (x, y) {
        if (x === y) return { rel: '비화', d: 4 };
        if (generates(x, y)) return { rel: '상생', d: 7 };
        if (generates(y, x)) return { rel: '역생', d: 3 };
        return { rel: '상극', d: -6 };
      };
      var aTail = A.name.syllables[A.name.syllables.length - 1].elem;
      var bTail = B.name.syllables[B.name.syllables.length - 1].elem;
      var aHead = A.name.syllables[0].elem;
      var bHead = B.name.syllables[0].elem;
      var ab = soundPair(aTail, bHead), ba = soundPair(bTail, aHead);
      var rel2 = ab.rel === ba.rel ? ab.rel : ab.rel + '·' + ba.rel;
      add('communication', (ab.d + ba.d) / 2, '두 이름을 이어 부르면 ' + rel2);
      // 상대 이름이 내 용신을 불러 주는가
      var bElems = B.name.syllables.map(function (s2) { return s2.elem; });
      if (bElems.indexOf(A.analysis.yongsin[0]) >= 0) {
        add('stability', 5, '상대 이름에 내 용신 ' + josa(A.analysis.yongsin[0], '이/가') + ' 들어 있음');
      }
      var aElems = A.name.syllables.map(function (s2) { return s2.elem; });
      if (aElems.indexOf(B.analysis.yongsin[0]) >= 0) {
        add('stability', 5, '내 이름에 상대 용신 ' + josa(B.analysis.yongsin[0], '이/가') + ' 들어 있음');
      }
      nameNote = { tailHeadRelation: rel2, forward: ab.rel, backward: ba.rel,
                   aElems: aElems, bElems: bElems };
    }

    // ── 월지 (자라온 환경) ──
    branchRelations(pa.month.branch, pb.month.branch).forEach(function (rel) {
      if (rel.name === '충') add('endurance', -5, '월지 충 — 살아온 결이 다름');
      if (rel.name === '육합' || rel.name === '삼합') add('endurance', 4, '월지 ' + rel.name + ' — 배경이 비슷함');
    });

    COMPAT_AXES.forEach(function (k) {
      axes[k].score = Math.max(0, Math.min(100, Math.round(axes[k].score)));
      axes[k].label = COMPAT_LABEL[k];
      axes[k].items.sort(function (x, y2) { return Math.abs(y2.delta) - Math.abs(x.delta); });
    });
    var raw = Math.round(COMPAT_AXES.reduce(function (acc, k) {
      return acc + axes[k].score * COMPAT_WEIGHT[k];
    }, 0));
    var total = compatPercentile(raw);

    var all = [];
    COMPAT_AXES.forEach(function (k) {
      axes[k].items.forEach(function (it) { all.push({ axis: COMPAT_LABEL[k], label: it.label, delta: it.delta }); });
    });
    var strengths = all.filter(function (i2) { return i2.delta > 0; })
                       .sort(function (x, y2) { return y2.delta - x.delta; }).slice(0, 5);
    var frictions = all.filter(function (i2) { return i2.delta < 0; })
                       .sort(function (x, y2) { return x.delta - y2.delta; }).slice(0, 5);

    return {
      total: total, raw: raw, axes: axes, strengths: strengths, frictions: frictions,
      detail: {
        dayStems: [STEM[sa] + '(' + STEM_H[sa] + ')', STEM[sb] + '(' + STEM_H[sb] + ')'],
        dayStemRelation: stemRel ? stemRel.name : (ea === eb ? '같은 오행' : (generates(ea, eb) || generates(eb, ea) ? '상생' : (controls(ea, eb) || controls(eb, ea) ? '상극' : '무관'))),
        dayBranchRelations: branchRelations(ba, bb).map(function (r) { return r.name; }),
        zodiacRelations: branchRelations(za, zb).map(function (r) { return r.name; }),
        zodiac: [BRANCH_ANIMAL[za], BRANCH_ANIMAL[zb]],
        godBtoA: godBtoA, godAtoB: godAtoB,
        strength: [A.analysis.strength, B.analysis.strength],
        season: [seasonA, seasonB],
        yongsin: [A.analysis.yongsin[0], B.analysis.yongsin[0]],
        supply: { toMe: supAB, toThem: supBA },
        name: nameNote
      }
    };
  }

  // ── 연락처 읽기 ─────────────────────────────────────────────────────────
  //
  // 카카오톡은 친구 생일을 내보내는 방법이 없다(공개 API도, 내보내기 메뉴도 없다).
  // 대신 휴대폰·구글 연락처에서 내보낸 파일을 읽는다. 파일은 브라우저 안에서만
  // 열리고 서버로 올라가지 않는다.
  //
  //   · vCard(.vcf)  — 아이폰/안드로이드/구글 연락처 공통 내보내기 형식
  //   · CSV          — 구글 연락처, 아웃룩
  //   · 직접 붙여넣기 — "이름 1990-05-15" 같은 줄 목록
  function parseBirthday(raw) {
    if (!raw) return null;
    // "1990. 5. 15." 처럼 점과 공백이 섞인 표기도 흔하다.
    var t = String(raw).trim().replace(/\s+/g, '').replace(/[.\/]$/, '');
    var m;
    // 연도가 없는 형식(--MMDD)은 사주를 세울 수 없다. 가장 먼저 걸러 낸다.
    if (/^-{1,2}\d{2}-?\d{2}$/.test(t)) return { noYear: true };
    // 자릿수가 고정된 형식부터 본다. 아래 두 줄의 순서가 바뀌면 930722 가
    // 9307년 2월 2일로 읽힌다.
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) {
      return { year: +m[1], month: +m[2], day: +m[3] };
    }
    if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(t))) {
      var yy = +m[1];
      var nowYY = new Date().getFullYear() % 100;
      return { year: yy <= nowYY ? 2000 + yy : 1900 + yy,
               month: +m[2], day: +m[3], guessedCentury: true };
    }
    if ((m = /^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})$/.exec(t))) {
      return { year: +m[1], month: +m[2], day: +m[3] };
    }
    return null;
  }

  function validDate(d) {
    if (!d || d.noYear) return false;
    if (d.year < 1900 || d.year > 2100) return false;
    if (d.month < 1 || d.month > 12) return false;
    if (d.day < 1 || d.day > 31) return false;
    return true;
  }

  function parseVCards(text) {
    var out = [];
    // 76자에서 접힌 줄은 다음 줄이 공백/탭으로 시작한다 — 먼저 펴 준다.
    var lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    var cur = null;
    lines.forEach(function (line) {
      if (/^BEGIN:VCARD/i.test(line)) { cur = { name: null, n: null, bday: null }; return; }
      if (/^END:VCARD/i.test(line)) {
        if (cur) out.push({ name: cur.name || cur.n || '(이름 없음)', bday: cur.bday });
        cur = null; return;
      }
      if (!cur) return;
      var idx = line.indexOf(':');
      if (idx < 0) return;
      var key = line.slice(0, idx).split(';')[0].toUpperCase();
      var val = line.slice(idx + 1).trim();
      if (key === 'FN') cur.name = val;
      else if (key === 'N' && !cur.n) {
        // vCard 의 N 은 성;이름 순서다. 한글 이름은 성+이름으로 그대로 붙이고,
        // 로마자 이름만 이름 성 순서로 돌린다.
        var pieces = val.split(';');
        var family = (pieces[0] || '').trim(), given = (pieces[1] || '').trim();
        cur.n = /^[가-힣]+$/.test(family + given)
          ? (family + given)
          : (given + ' ' + family).trim();
      }
      else if (key === 'BDAY') cur.bday = val;
    });
    return out;
  }

  function splitCsvLine(line) {
    var out = [], cur = '', quoted = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseCsv(text) {
    var lines = text.replace(/\r\n/g, '\n').split('\n').filter(function (l) { return l.trim(); });
    if (!lines.length) return [];
    var head = splitCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
    var find = function (words) {
      for (var i = 0; i < head.length; i++) {
        for (var j = 0; j < words.length; j++) if (head[i].indexOf(words[j]) >= 0) return i;
      }
      return -1;
    };
    var iBday = find(['birthday', 'birth', '생일', '생년월일']);
    if (iBday < 0) return [];
    var iName = find(['file as', 'display name', 'full name', '이름', '성명', 'name']);
    var iFirst = find(['first name', 'given name']);
    var iLast = find(['last name', 'family name']);

    return lines.slice(1).map(function (l) {
      var c = splitCsvLine(l);
      var name = (iName >= 0 ? c[iName] : '') || '';
      if (!name.trim() && (iFirst >= 0 || iLast >= 0)) {
        name = ((iLast >= 0 ? c[iLast] : '') + (iFirst >= 0 ? c[iFirst] : '')).trim();
      }
      return { name: (name || '(이름 없음)').trim(), bday: (c[iBday] || '').trim() };
    });
  }

  function parsePlainLines(text) {
    return text.replace(/\r\n/g, '\n').split('\n').map(function (l) { return l.trim(); })
      .filter(Boolean)
      .map(function (line) {
        // "홍길동 1990-05-15", "홍길동, 900515", "홍길동\t1990.5.15"
        var m = /^(.*?)[\s,\t]+([\d\-./]{6,10})\s*$/.exec(line);
        // 날짜가 없는 줄도 버리지 않고 넘긴다 — 몇 명이 왜 빠졌는지 보여 줘야
        // 사용자가 목록을 고칠 수 있다.
        if (!m) return { name: line.replace(/[,\t]+$/, ''), bday: null };
        return { name: m[1].trim().replace(/[,\t]+$/, '') || '(이름 없음)', bday: m[2] };
      });
  }

  /**
   * 연락처 텍스트를 사람 목록으로. 형식은 내용을 보고 알아서 고른다.
   * @returns {{people: Array, skipped: Array, total: number}}
   */
  function parseContacts(text) {
    if (!text || !text.trim()) return { people: [], skipped: [], total: 0 };
    var rows;
    if (/BEGIN:VCARD/i.test(text)) rows = parseVCards(text);
    else if (/^[^\n]*,[^\n]*\n/.test(text) && parseCsv(text).length) rows = parseCsv(text);
    else rows = parsePlainLines(text);

    var people = [], skipped = [];
    rows.forEach(function (r) {
      if (!r.bday) { skipped.push({ name: r.name, reason: '생일 없음' }); return; }
      var d = parseBirthday(r.bday);
      if (d && d.noYear) { skipped.push({ name: r.name, reason: '연도가 없는 생일(--MMDD)' }); return; }
      if (!validDate(d)) { skipped.push({ name: r.name, reason: '생일 형식을 읽지 못함: ' + r.bday }); return; }
      people.push({
        name: r.name, year: d.year, month: d.month, day: d.day,
        guessedCentury: !!d.guessedCentury
      });
    });
    return { people: people, skipped: skipped, total: rows.length };
  }

  // ── 한 번에 뽑아 쓰는 진입점 ────────────────────────────────────────────
  function fullReading(input) {
    var solar = input.calendar === '음력'
      ? lunarToSolar(input.year, input.month, input.day, input.leapMonth)
      : { year: input.year, month: input.month, day: input.day };
    if (solar.error) return { error: solar.error };

    var chart = buildChart({
      year: solar.year, month: solar.month, day: solar.day,
      hour: input.hour, minute: input.minute,
      gender: input.gender, longitude: input.longitude,
      useSolarTime: input.useSolarTime, lateNightRule: input.lateNightRule
    });
    var an = analyze(chart);
    var luck = buildLuckCycles(chart, input.gender);
    var name = input.surname && input.given
      ? analyzeName(input.surname, input.given, {
          yongsin: an.yongsin, missing: an.missing, excess: an.excess, hanja: input.hanja })
      : null;

    var p = chart.pillars;
    function pillarText(pl) {
      if (!pl) return null;
      return {
        stem: STEM[pl.stem], branch: BRANCH[pl.branch],
        hanja: STEM_H[pl.stem] + BRANCH_H[pl.branch],
        korean: STEM[pl.stem] + BRANCH[pl.branch],
        stemElem: STEM_ELEM[pl.stem], branchElem: BRANCH_ELEM[pl.branch],
        stemYinYang: isYang(pl.stem) ? '양' : '음',
        animal: BRANCH_ANIMAL[pl.branch],
        hidden: HIDDEN[pl.branch].map(function (x) { return STEM[x[0]]; })
      };
    }

    var now = new Date();
    var thisYear = now.getFullYear();
    var nowJD = toJD(thisYear, now.getMonth() + 1, now.getDate(), 12);
    var exactAge = (nowJD - chart.birthJD) / 365.2422;   // 만나이(소수)
    var koreanAge = thisYear - solar.year + 1;           // 세는나이
    var current = null;
    for (var i = 0; i < luck.list.length; i++) {
      if (exactAge >= luck.list[i].ageFrom && exactAge < luck.list[i].ageTo) { current = luck.list[i]; break; }
    }

    var out = {
      solar: solar,
      // 여러 명을 한꺼번에 볼 때는 음력 변환과 90년치 운세 계산이 전부 낭비다.
      // 궁합은 원국끼리 보는 것이라 둘 다 필요 없다.
      lunar: input.skipLunar ? null : solarToLunar(solar.year, solar.month, solar.day),
      chart: chart,
      pillars: {
        year: pillarText(p.year), month: pillarText(p.month),
        day: pillarText(p.day), hour: pillarText(p.hour)
      },
      analysis: an,
      luck: luck,
      currentLuck: current,
      currentYear: { year: thisYear, pillar: yearPillarOf(thisYear),
                     koreanAge: koreanAge, age: Math.floor(exactAge) },
      name: name
    };
    // 운세 시기는 원국·대운이 다 나온 뒤라야 매길 수 있다.
    if (!input.skipFortune) out.fortune = fortuneTimeline(out, input.fortuneWindow);
    return out;
  }

  return {
    STEM: STEM, STEM_H: STEM_H, BRANCH: BRANCH, BRANCH_H: BRANCH_H,
    BRANCH_ANIMAL: BRANCH_ANIMAL, STEM_ELEM: STEM_ELEM, BRANCH_ELEM: BRANCH_ELEM,
    ELEMS: ELEMS, ELEM_H: ELEM_H, ELEM_COLOR: ELEM_COLOR, HIDDEN: HIDDEN,
    SOLAR_TERM_NAMES: SOLAR_TERM_NAMES,
    isYang: isYang, generates: generates, controls: controls,
    toJD: toJD, fromJD: fromJD, sunLongitude: sunLongitude, jdUTtoTT: jdUTtoTT,
    solveSolarLongitude: solveSolarLongitude, newMoonJD: newMoonJD,
    equationOfTime: equationOfTime, standardOffset: standardOffset, inDST: inDST,
    buildChart: buildChart, analyze: analyze, buildLuckCycles: buildLuckCycles,
    yearPillarOf: yearPillarOf, tenGodOfStem: tenGodOfStem, tenGodOfBranch: tenGodOfBranch,
    solarToLunar: solarToLunar, lunarToSolar: lunarToSolar, leapMonthsOf: leapMonthsOf,
    syllableInfo: syllableInfo, suriOf: suriOf, analyzeName: analyzeName,
    branchRelations: branchRelations, stemRelation: stemRelation,
    fortuneTimeline: fortuneTimeline, DOMAIN_LABEL: DOMAIN_LABEL,
    compatibility: compatibility, COMPAT_AXES: COMPAT_AXES, COMPAT_LABEL: COMPAT_LABEL,
    parseContacts: parseContacts, parseBirthday: parseBirthday,
    fullReading: fullReading
  };
});
