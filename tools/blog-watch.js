#!/usr/bin/env node
// N드라이브(또는 아무 사진 폴더)를 지켜보다가 새 사진이 쌓이면 블로그 초안을 만들어 둔다.
//
//   node tools/blog-watch.js "C:\Users\내이름\N드라이브\사진"
//   node tools/blog-watch.js "N:\사진" --topic 맛집 --keyword "성수 칼국수"
//   node tools/blog-watch.js "N:\사진" --once          한 번만 훑고 끝
//
// 사진은 내 PC 에서 바로 Claude 로 가고, 이 저장소의 서버(사이트)를 거치지 않는다.
// 그래서 사이트의 4.5MB 요청 한도가 없고, 키(.env 의 ANTHROPIC_API_KEY)도 PC 밖으로 나가지 않는다.
// 초안은 blog-drafts 폴더에 txt 로 저장된다 — 열어서 읽고, 마음에 들면 /blog 의 글 칸에
// 붙여넣어 "내 생각 넣어 다시 쓰기"로 이어 가면 된다.
//
// 옵션
//   --since 2026-10-20   이 날짜 이후에 바뀐 사진만 (기본: 오늘 0시. 옛 사진 수십 장이
//                        한꺼번에 요금으로 나가는 일을 막는다)
//   --max-posts 5        한 번 실행에서 만들 초안 수 상한 (기본 5)
//   --gap 20             사진 사이가 이 분 넘게 벌어지면 다른 글로 본다 (기본 20)
//   --quiet 3            마지막 사진이 올라온 뒤 이 분 동안 조용하면 업로드가 끝난 것으로 본다
//   --out blog-drafts    초안 저장 폴더
//   --topic / --keyword / --tone / --length   /blog 화면의 같은 항목
//
// 라이브포토(HEIC+MOV)도 됩니다: 사진만 JPG 로 바꿔 쓰고 영상은 무시합니다.
// 5MB 가 넘는 원본도 줄여서 보내므로 상관없습니다.
//
// 사진과 같은 폴더에 "메모.txt" 가 있으면 가격·이름 같은 확실한 정보로 읽어 간다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 아이폰 라이브포토는 사진(HEIC)과 짧은 영상(MOV)이 한 쌍으로 올라온다. 영상은 글에 쓰지
// 않으므로 확장자 목록에 없어 자연스럽게 빠지고, 사진(HEIC)만 JPG 로 바꿔 쓴다.
const IMG = /\.(jpe?g|png|webp|heic|heif)$/i;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_PER_POST = 6;
const POLL_MS = 30 * 1000;

// ── 사진을 글 단위로 묶는다 ────────────────────────────────────────────────
// 시간순으로 놓고, 앞 사진과 gapMs 넘게 벌어지면 새 글로 자른다. 한 글은 6장까지.
function groupFiles(files, gapMs) {
  const sorted = files.slice().sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
  const groups = [];
  let cur = [];
  for (const f of sorted) {
    const prev = cur[cur.length - 1];
    if (cur.length && (f.mtime - prev.mtime > gapMs || cur.length >= MAX_PER_POST)) {
      groups.push(cur); cur = [];
    }
    cur.push(f);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function parseArgs(argv) {
  const opts = { dir: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'once') opts.flags.once = true;
      else opts.flags[key] = argv[++i];
    } else if (!opts.dir) opts.dir = a;
  }
  return opts;
}

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
}

function walk(dir, skip, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (path.resolve(p) === skip) continue;
    if (e.isDirectory()) walk(p, skip, out);
    else if (IMG.test(e.name)) {
      try { const s = fs.statSync(p); out.push({ path: p, mtime: s.mtimeMs, size: s.size }); } catch (e2) { /* 지워진 파일 */ }
    }
  }
  return out;
}

// 폰 사진은 원본이 5MB 를 넘기 일쑤고 라이브포토는 HEIC 라서 그대로는 못 보낸다.
// 그래서 항상 JPG 로 바꾸고 긴 쪽 1600px 로 줄여서 보낸다(보통 300KB 안팎).
//   · HEIC → JPG: heic-convert (순수 JS, 윈도우·맥 어디서나 설치됨)
//   · 줄이기·회전: sharp
// 둘 다 optionalDependencies 라서 npm install 만 하면 들어온다.
let sharp = null, heicConvert = null;
try { sharp = require('sharp'); } catch (e) { /* 아래 시작 안내에서 알린다 */ }
try { heicConvert = require('heic-convert'); } catch (e) { /* 위와 같다 */ }
const isHeic = (p) => /\.(heic|heif)$/i.test(p);

async function loadImage(file) {
  let raw = fs.readFileSync(file.path);
  if (isHeic(file.path)) {
    if (!heicConvert) return { skip: 'HEIC 를 바꿀 도구(heic-convert)가 없습니다. npm install 을 다시 해 주세요.' };
    const jpg = await heicConvert({ buffer: raw, format: 'JPEG', quality: 0.9 });
    raw = Buffer.from(jpg);
  }
  if (sharp) {
    const buf = await sharp(raw).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }).toBuffer();
    return { image: { media_type: 'image/jpeg', data: buf.toString('base64') } };
  }
  // sharp 가 없으면 줄일 수 없으니 5MB 이하 JPG/PNG/WEBP 만 그대로 보낸다.
  if (raw.length > 5 * 1024 * 1024) return { skip: '5MB 가 넘는데 사진을 줄일 도구(sharp)가 없습니다. npm install 을 다시 해 주세요.' };
  const ext = isHeic(file.path) ? '.jpg' : path.extname(file.path).toLowerCase();
  return { image: { media_type: MIME[ext], data: raw.toString('base64') } };
}

function stamp(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

async function main() {
  const { dir, flags } = parseArgs(process.argv.slice(2));
  const watchDir = dir || process.env.BLOG_WATCH_DIR;
  if (!watchDir || !fs.existsSync(watchDir)) {
    console.error('사진 폴더를 알려 주세요.\n  node tools/blog-watch.js "N드라이브 사진 폴더 경로"');
    process.exit(1);
  }
  loadDotEnv();
  if (!String(process.env.ANTHROPIC_API_KEY || '').trim()) {
    console.error('.env 파일에 ANTHROPIC_API_KEY=sk-ant-... 를 넣어 주세요.');
    process.exit(1);
  }
  const blog = require('../api/blog.js');
  const AnthropicModule = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default || AnthropicModule;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim().replace(/^["']|["']$/g, '') });

  const outDir = path.resolve(flags.out || path.join(ROOT, 'blog-drafts'));
  fs.mkdirSync(outDir, { recursive: true });
  const stateFile = path.join(outDir, '.state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { /* 처음 */ }
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const since = flags.since ? new Date(flags.since + 'T00:00:00').getTime() : today.getTime();
  const gapMs = (Number(flags.gap) || 20) * 60 * 1000;
  const quietMs = flags.once ? 0 : (flags.quiet === undefined ? 3 : Number(flags.quiet)) * 60 * 1000;
  const maxPosts = Number(flags['max-posts']) || 5;
  const opt = (k, ok, d) => (ok.indexOf(flags[k]) >= 0 ? flags[k] : d);
  const base = {
    topic: opt('topic', blog.TOPICS, '기타'), keyword: (flags.keyword || '').slice(0, 80),
    tone: opt('tone', blog.TONES, 'friendly'), length: opt('length', blog.LENGTHS, 'normal')
  };
  const idOf = (f) => f.path + '|' + f.mtime + '|' + f.size;

  console.log('폴더를 지켜보는 중: ' + watchDir);
  console.log('초안 저장 위치: ' + outDir + '  (모델: ' + blog.MODEL + (sharp ? ', JPG 변환·축소 켜짐' : ', 사진 축소 꺼짐(npm install 필요)') + ')');

  async function scan() {
    const files = walk(watchDir, outDir, []).filter((f) => f.mtime >= since && f.size > 0 && !state[idOf(f)]);
    const now = Date.now();
    const ready = groupFiles(files, gapMs).filter((g) => now - g[g.length - 1].mtime >= quietMs);
    let made = 0;
    for (const g of ready) {
      if (made >= maxPosts) { console.log('한 번에 만들 수 있는 상한(' + maxPosts + ')에 도달했습니다. 다음 확인 때 이어서 만듭니다.'); break; }
      const label = path.basename(g[0].path) + ' 외 ' + (g.length - 1) + '장';
      try {
        const imgs = [], used = [];
        for (const f of g) {
          const r = await loadImage(f);
          if (r.image) { imgs.push(r.image); used.push(f); } else console.log('  건너뜀: ' + f.path + ' — ' + r.skip);
        }
        if (!imgs.length) { g.forEach((f) => { state[idOf(f)] = 'skipped'; }); saveState(); continue; }
        let notes = '';
        const memo = path.join(path.dirname(g[0].path), '메모.txt');
        if (fs.existsSync(memo)) notes = fs.readFileSync(memo, 'utf8').slice(0, 3000);

        const res = await client.messages.create(blog.draftRequest(Object.assign({}, base, { images: imgs, notes })));
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const name = stamp(g[0].mtime) + '_초안.txt';
        const header = ['[사진 순서] 글의 [사진N] 자리에 올릴 파일'].concat(
          used.map((f, i) => '[사진' + (i + 1) + '] ' + path.relative(watchDir, f.path)),
          ['', '---- 여기 아래부터가 글입니다 ----', '']).join('\n');
        fs.writeFileSync(path.join(outDir, name), header + text + '\n');
        g.forEach((f) => { state[idOf(f)] = name; });
        saveState();
        made++;
        console.log('초안 완성: ' + name + '  (' + label + ')');
      } catch (e) {
        // 같은 사진이 계속 실패하면 요금만 나가므로 한 번 실패한 사진은 다시 시도하지 않는다.
        // 다시 만들고 싶으면 blog-drafts/.state.json 에서 그 줄을 지운다.
        console.error('실패: ' + label + ' — ' + String(e && e.message || e).slice(0, 200));
        g.forEach((f) => { state[idOf(f)] = 'failed'; });
        saveState();
      }
    }
    return made;
  }

  if (flags.once) { await scan(); return; }
  for (;;) {
    await scan();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();
module.exports = { groupFiles, main };
