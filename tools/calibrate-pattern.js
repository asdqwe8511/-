#!/usr/bin/env node
/* 격국과 드문 구조가 실제로 얼마나 드문지 세어, RARITY 표를 다시 만든다.
 *
 * "희귀한 패턴"이라는 말을 근거 없이 하지 않으려고 둔 도구다. 무작위로 만든
 * 사주에서 그 배치가 몇 %나 나오는지 세면, "드물다/흔하다"를 숫자로 말할 수
 * 있다. 오행 하나가 없는 사주는 열에 여섯이라 전혀 드물지 않은데, 그걸 모르면
 * "귀한 사주"라고 잘못 말하게 된다.
 *
 * 생일은 1940~2009년의 날짜와 시각에서 고르게 뽑는다. 실제 인구 분포는 아니지만
 * 간지는 60갑자로 도는 값이라 고르게 뽑아도 치우치지 않는다.
 *
 *   node tools/calibrate-pattern.js [개수]
 */
'use strict';
const E = require('../saju-engine.js');

const N = parseInt(process.argv[2], 10) || 20000;
const SEED = 20260902;
let seed = SEED;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const shapeCount = {};
const patternCount = {};
let made = 0;

while (made < N) {
  const r = E.fullReading({
    year: 1940 + Math.floor(rnd() * 70),
    month: 1 + Math.floor(rnd() * 12),
    day: 1 + Math.floor(rnd() * 28),
    hour: Math.floor(rnd() * 24),
    minute: 0,
    gender: rnd() < 0.5 ? '남' : '여',
    skipLunar: true, skipFortune: true
  });
  if (r.error) continue;
  made++;
  patternCount[r.analysis.pattern.name] = (patternCount[r.analysis.pattern.name] || 0) + 1;
  const seen = {};
  E.findRareShapes(r.chart, r.analysis).forEach((s) => { seen[s.name] = 1; });
  Object.keys(seen).forEach((k) => { shapeCount[k] = (shapeCount[k] || 0) + 1; });
}

process.stderr.write(made + '개\n\n');
process.stderr.write('격국 분포\n');
Object.keys(patternCount).sort((a, b) => patternCount[b] - patternCount[a]).forEach((k) => {
  process.stderr.write('  ' + k + ' ' + (patternCount[k] / made * 100).toFixed(1) + '%\n');
});

console.log('  // ' + made + '개 표본, 씨앗 ' + SEED + ' (tools/calibrate-pattern.js)');
console.log('  var RARITY = {');
const keys = Object.keys(shapeCount).sort((a, b) => shapeCount[a] - shapeCount[b]);
keys.forEach((k, i) => {
  const pct = (shapeCount[k] / made * 100).toFixed(1);
  console.log("    '" + k + "': " + pct + (i < keys.length - 1 ? ',' : ''));
});
console.log('  };');
