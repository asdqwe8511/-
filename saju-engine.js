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

    return {
      solar: solar,
      lunar: solarToLunar(solar.year, solar.month, solar.day),
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
    fullReading: fullReading
  };
});
