#!/usr/bin/env node
/* 디자인 토큰이 새는 곳을 잡는다.
 *
 *   node tools/check-design.js            → 기준선보다 늘었으면 실패
 *   node tools/check-design.js --list     → 어긋난 자리를 파일·줄 번호로 전부 출력
 *   node tools/check-design.js --update   → 지금 상태를 새 기준선으로 저장
 *
 * 왜 "0" 이 아니라 "기준선" 인가.
 * index.html 한 파일에만 직접 박아 넣은 값이 수백 개다. 그걸 한 번에 다 고치는
 * 것은 위험하고(화면이 조용히 틀어진다), 그렇다고 검사를 아예 안 걸면 새 코드가
 * 계속 같은 방식으로 쌓인다. 그래서 "지금 있는 만큼은 봐주되, 늘어나면 막는다".
 * 값을 토큰으로 옮길 때마다 숫자가 내려가고, --update 로 기준선을 조여 두면
 * 다시 올라올 수 없다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'tools', 'design-baseline.json');

// 검사 대상. tokens.css 는 값이 있어야 하는 유일한 파일이라 뺀다.
const TARGETS = ['index.html', 'youtube.html'];

const RULES = [
  { id: 'hex-color',    re: /#[0-9a-fA-F]{3,8}\b/g,
    hint: '색은 var(--color-…) 로. 없으면 tokens.css 에 먼저 추가한다.' },
  { id: 'rgba-color',   re: /\brgba?\(\s*\d+\s*,/g,
    hint: '반투명 색도 토큰이다. tokens.css 의 --color-…-weak / -line 참고.' },
  { id: 'font-size',    re: /font-size\s*:\s*[\d.]+(px|rem|em)/g,
    hint: '글자 크기는 var(--fs-…) 로.' },
  { id: 'radius',       re: /border-radius\s*:\s*[\d.]+(px|rem)/g,
    hint: '모서리는 var(--radius-…) 로.' },
  { id: 'shadow',       re: /box-shadow\s*:\s*(?!var\()[^;}]+/g,
    hint: '그림자는 var(--shadow-…) 로.' },
  { id: 'duration',     re: /transition\s*:\s*(?!var\()[^;}]*\b[\d.]+m?s/g,
    hint: '시간은 var(--dur…), 가속은 var(--ease) 로.' },
];

function scan(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = text.split('\n');
  const hits = {};
  for (const rule of RULES) hits[rule.id] = [];
  lines.forEach((line, i) => {
    // data: URI 안에 든 값은 이미지의 일부다. 토큰으로 바꿀 수 없다.
    if (/data:image\//.test(line)) return;
    // <meta name="theme-color"> 는 브라우저 UI 가 읽는 값이라 var() 를 못 쓴다.
    // tokens.css 의 --color-bg 와 같은 값을 손으로 맞춰 둔다.
    if (/name=["']theme-color["']/.test(line)) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        hits[rule.id].push({ line: i + 1, text: m[0].trim().slice(0, 60) });
      }
    }
  });
  return hits;
}

const listMode   = process.argv.includes('--list');
const updateMode = process.argv.includes('--update');

const current = {};
for (const file of TARGETS) {
  if (!fs.existsSync(path.join(ROOT, file))) continue;
  const hits = scan(file);
  current[file] = {};
  for (const rule of RULES) current[file][rule.id] = hits[rule.id].length;
  if (listMode) {
    console.log('\n' + file);
    for (const rule of RULES) {
      for (const h of hits[rule.id]) {
        console.log(`  ${file}:${h.line}  [${rule.id}]  ${h.text}`);
      }
    }
  }
}

if (updateMode) {
  fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log('기준선을 지금 상태로 저장했습니다: tools/design-baseline.json');
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.log('기준선이 없습니다. 먼저 한 번 실행하세요:  node tools/check-design.js --update');
  process.exit(0);
}
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

let grew = 0, shrank = 0;
for (const file of Object.keys(current)) {
  for (const rule of RULES) {
    const now = current[file][rule.id];
    const was = (base[file] || {})[rule.id] ?? 0;
    if (now > was) {
      grew++;
      console.log(`✗ ${file}  [${rule.id}]  ${was} → ${now} (${now - was}개 늘었습니다)`);
      console.log(`    ${rule.hint}`);
    } else if (now < was) {
      shrank++;
    }
  }
}

if (grew) {
  console.log('\n토큰을 거치지 않은 값이 늘었습니다. styles/tokens.css 의 var(--…) 를 쓰세요.');
  console.log('어디인지 보려면:  node tools/check-design.js --list');
  process.exit(1);
}
if (shrank) {
  console.log(`✓ 어긋난 값이 줄었습니다(${shrank}종). 기준선을 조여 두세요:  node tools/check-design.js --update`);
} else {
  console.log('✓ 디자인 토큰: 새로 샌 값 없음.');
}
