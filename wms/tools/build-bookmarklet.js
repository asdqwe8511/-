/* 북마클릿 원본(.js)을 즐겨찾기 주소 한 줄로 바꾼다.
   주석과 줄바꿈을 걷어낸 뒤 통째로 퍼센트 인코딩한다 —
   한글·따옴표·# 가 섞여 있어도 주소창이 잘라먹지 않게 하기 위함이다. */
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('사용법: node build-bookmarklet.js <원본.js>'); process.exit(1); }

let code = fs.readFileSync(src, 'utf8');

// 문자열 안의 // 나 /* 를 건드리지 않도록 한 글자씩 훑으며 주석만 걷어낸다
function stripComments(s) {
  let out = '', i = 0, q = null;
  while (i < s.length) {
    const ch = s[i], nx = s[i + 1];
    if (q) {
      out += ch;
      if (ch === '\\') { out += nx === undefined ? '' : nx; i += 2; continue; }
      if (ch === q) q = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; out += ch; i++; continue; }
    if (ch === '/' && nx === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

code = stripComments(code)
  .split('\n').map(l => l.trim()).filter(Boolean).join(' ')
  .replace(/\s{2,}/g, ' ');

/* 꼭 필요한 글자만 인코딩한다. 전부 인코딩하면 한글 한 자가 9글자로 부풀어
   주소가 두 배 가까이 길어지고, 옮겨 붙이기가 그만큼 번거로워진다.
   즐겨찾기 주소는 브라우저가 그대로 보관하므로 한글·따옴표는 날것으로 둬도 된다. */
const url = 'javascript:' + code.replace(/[%#"]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase()) + ';void 0';
const out = src.replace(/\.js$/, '.bookmarklet.txt');
fs.writeFileSync(out, url + '\n', 'utf8');
console.log(path.basename(out) + ' — ' + url.length.toLocaleString() + '자');
