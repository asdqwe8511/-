#!/usr/bin/env node
/* hanja-data.js 를 다시 만든다.
 *
 * 원자료 두 개를 받아 합친다(둘 다 저장소에 두지 않는다. 받는 법은
 * tools/build-hanja.md 참고).
 *   1) PyPI `hanja` 의 hanja/table.yml   — 한자 → 한글 음
 *   2) npm  `hanzi-writer-data`          — 글자별 획 데이터. 그 개수가 획수
 *
 *   node tools/build-hanja.js <table.yml> <hanzi-writer-data 디렉터리> > hanja-data.js
 */
'use strict';
var fs = require('fs'), path = require('path');

var ymlPath = process.argv[2], hwDir = process.argv[3];
if (!ymlPath || !hwDir) {
  console.error('사용법: node tools/build-hanja.js <hanja/table.yml> <hanzi-writer-data/>');
  console.error('원자료 받는 법은 tools/build-hanja.md 를 보세요.');
  process.exit(1);
}

// table.yml 은 "㐀": "구" 꼴의 한 줄짜리 항목만 들어 있어, YAML 파서 없이 읽는다.
var readingOf = {};
fs.readFileSync(ymlPath, 'utf8').split('\n').forEach(function (line) {
  var m = /^"((?:\\u[0-9A-Fa-f]{4})+)":\s*"((?:\\u[0-9A-Fa-f]{4})+)"\s*$/.exec(line.trim());
  if (!m) return;
  var un = function (s) { return s.replace(/\\u([0-9A-Fa-f]{4})/g, function (_, h) {
    return String.fromCharCode(parseInt(h, 16)); }); };
  readingOf[un(m[1])] = un(m[2]);
});

var strokes = {};
fs.readdirSync(hwDir).forEach(function (f) {
  if (path.extname(f) !== '.json') return;
  var ch = path.basename(f, '.json');
  if (ch.length !== 1) return;
  try {
    var d = JSON.parse(fs.readFileSync(path.join(hwDir, f), 'utf8'));
    if (Array.isArray(d.strokes)) strokes[ch] = d.strokes.length;
  } catch (e) { /* 읽히지 않는 파일은 건너뛴다 */ }
});

// KS X 1001 만 남긴다. euc-kr 로 표현되는지가 곧 그 판별이라 별도 목록이
// 필요 없고, 중국 간체자(悯·书·优 …)가 저절로 빠진다.
var KS_SET = (function () {
  var dec;
  try { dec = new TextDecoder('euc-kr', { fatal: true }); }
  catch (e) {
    console.error('이 Node 에는 euc-kr 디코더가 없습니다. full-icu 가 필요합니다.');
    process.exit(1);
  }
  var set = {};
  for (var hi = 0xA1; hi <= 0xFE; hi++) {
    for (var lo = 0xA1; lo <= 0xFE; lo++) {
      try { set[dec.decode(Buffer.from([hi, lo]))] = true; } catch (e) { /* 빈 자리 */ }
    }
  }
  return set;
})();

// 두음법칙. 원자료는 본음 하나만 갖고 있어서 李가 '리'에만, 柳가 '류'에만 들어
// 있다. 한국 이름은 두음을 적용한 표기(이·유·임·노·양)로 쓰므로, 두 음 모두에
// 넣어 준다. 규칙은 한글 맞춤법 제10~12항 그대로다.
//   녀·뇨·뉴·니 → 여·요·유·이   (ㄴ→ㅇ)
//   랴·려·례·료·류·리 → 야·여·예·요·유·이   (ㄹ→ㅇ)
//   라·래·로·뢰·루·르 → 나·내·노·뇌·누·느   (ㄹ→ㄴ)
// 종성은 그대로 두므로 량→양, 력→역, 룡→용, 린→인 도 함께 처리된다.
function dooeum(r) {
  var u = r.charCodeAt(0) - 0xAC00;
  if (u < 0 || u > 11171) return null;
  var jong = u % 28, jung = ((u - jong) / 28) % 21, cho = ((u - jong) / 28 / 21) | 0;
  var head = String.fromCharCode(0xAC00 + (cho * 21 + jung) * 28);
  var off = 0;
  if ('녀뇨뉴니'.indexOf(head) >= 0) off = 9;
  else if ('랴려례료류리'.indexOf(head) >= 0) off = 6;
  else if ('라래로뢰루르'.indexOf(head) >= 0) off = -3;
  if (!off) return null;
  return String.fromCharCode(0xAC00 + ((cho + off) * 21 + jung) * 28 + jong);
}

// 다음자(多音字) 보충. 원자료는 글자마다 음을 하나만 갖고 있어서, 두 가지로
// 읽는 글자의 나머지 음이 통째로 빠진다. 성씨 金(김)·沈(심)·葉(섭)처럼
// 이름에서 실제로 쓰이는 음만 손으로 채운다.
var EXTRA = {
  '金': ['김'], '沈': ['심'], '葉': ['섭'], '龜': ['귀'], '賈': ['고'],
  '樂': ['악', '요'], '辰': ['신'], '易': ['이'], '省': ['생'], '說': ['열', '세'],
  '復': ['부'], '車': ['거'], '度': ['탁'], '讀': ['두'], '宿': ['수'],
  '拾': ['십'], '洞': ['통'], '北': ['배'], '不': ['부'], '便': ['변'],
  '識': ['지'], '惡': ['오'], '若': ['야'], '切': ['체'], '則': ['즉'],
  '拓': ['탁'], '索': ['삭'], '數': ['삭'], '衰': ['최'], '食': ['사'], '宅': ['댁']
};

var byReading = {};
function put(r, ch) {
  var list = (byReading[r] = byReading[r] || []);
  if (list.indexOf(ch) < 0) list.push(ch);
}
Object.keys(readingOf).forEach(function (ch) {
  var r = readingOf[ch];
  if (ch.length !== 1 || r.length !== 1) return;
  if (!KS_SET[ch]) return;
  put(r, ch);
  var d = dooeum(r);
  if (d) put(d, ch);
  (EXTRA[ch] || []).forEach(function (e) { put(e, ch); });
});

var total = 0, known = 0, rows = [];
Object.keys(byReading).sort().forEach(function (r) {
  var list = byReading[r].slice().sort(function (a, b) {
    var sa = strokes[a] === undefined ? 99 : strokes[a];
    var sb = strokes[b] === undefined ? 99 : strokes[b];
    return sa - sb || (a < b ? -1 : 1);
  });
  var s = list.map(function (c) {
    total++;
    if (strokes[c] === undefined) return c + '?';
    known++; return c + strokes[c];
  }).join('');
  rows.push('    ' + JSON.stringify(r) + ': ' + JSON.stringify(s) + ',');
});

process.stderr.write('음절 ' + rows.length + ' / 한자 ' + total +
  ' / 획수 확인 ' + known + ' (' + (known / total * 100).toFixed(1) + '%)\n');
process.stdout.write(rows.join('\n') + '\n');
process.stderr.write('※ 위 본문을 hanja-data.js 의 TABLE 안에 넣으세요.\n');
