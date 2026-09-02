#!/usr/bin/env node
/* 궁합 원점수를 백분위로 바꾸는 기준표(분위값)를 다시 만든다.
 *
 * 네 축(끌림·안정·소통·지속)을 가중평균한 원점수는 대개 45~70 사이에 몰린다.
 * 그 숫자를 그대로 "궁합 56점"이라 내놓으면 누구와 붙여도 비슷해 보여 비교가
 * 안 된다. 그래서 무작위로 짝지은 사람들의 원점수 분포에 견주어 백분위로
 * 환산하고, 그 분포의 5% 간격 분위값을 표로 박아 둔다.
 *
 * 관계마다 축의 무게가 다르므로(애인은 끌림, 직장은 소통·지속) 분포도 다르다.
 * 관계별로 따로 뽑는다.
 *
 *   node tools/calibrate-compat.js [쌍 수]
 *
 * 결과를 saju-engine.js 의 COMPAT_BASELINE 과 REL_BASELINE 에 옮겨 넣는다.
 */
'use strict';
const E = require('../saju-engine.js');

const N = parseInt(process.argv[2], 10) || 20000;
const SEED = 20260902;
// 표가 실행마다 달라지면 "지난번엔 68이었는데" 하는 일이 생긴다. 난수를 고정한다.
let seed = SEED;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const pick = (a) => a[Math.floor(rnd() * a.length)];

function person() {
  return {
    year: 1940 + Math.floor(rnd() * 70),
    month: 1 + Math.floor(rnd() * 12),
    day: 1 + Math.floor(rnd() * 28),
    hour: Math.floor(rnd() * 24),
    minute: 0,
    gender: pick(['남', '여']),
    skipLunar: true, skipFortune: true
  };
}

const people = [];
while (people.length < Math.ceil(Math.sqrt(N * 2)) + 40) {
  const r = E.fullReading(person());
  if (!r.error) people.push(r);
}
process.stderr.write(`사람 ${people.length}명으로 짝을 짓습니다\n`);

const raws = { total: [] };
E.REL_TYPES.forEach((t) => { raws[t] = []; });

let pairs = 0;
for (let i = 0; i < people.length && pairs < N; i++) {
  for (let j = i + 1; j < people.length && pairs < N; j++) {
    const c = E.compatibility(people[i], people[j]);
    raws.total.push(c.raw);
    const rel = E.relationCompat(people[i], people[j], c);
    E.REL_TYPES.forEach((t) => { raws[t].push(rel.types[t].raw); });
    pairs++;
  }
}
process.stderr.write(`${pairs}쌍\n`);

function quantiles(list) {
  const v = list.slice().sort((a, b) => a - b);
  const out = [];
  for (let p = 0; p <= 100; p += 5) {
    out.push(v[Math.min(v.length - 1, Math.floor((v.length - 1) * p / 100))]);
  }
  return out;
}

console.log('// ' + pairs + '쌍, 씨앗 ' + SEED);
console.log('var COMPAT_BASELINE = [' + quantiles(raws.total).join(', ') + '];');
console.log('var REL_BASELINE = {');
E.REL_TYPES.forEach((t, i) => {
  console.log('    ' + t + (t.length < 6 ? ' '.repeat(6 - t.length) : '') +
    ': [' + quantiles(raws[t]).join(', ') + ']' + (i < E.REL_TYPES.length - 1 ? ',' : ''));
});
console.log('};');
