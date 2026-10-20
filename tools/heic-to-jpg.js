#!/usr/bin/env node
// N드라이브(또는 아무 사진 폴더)의 HEIC 사진을 JPG 로 바꿔 바탕화면의 "네이버마이박스" 폴더에
// 따로 모아 둔다. 원본은 건드리지 않는다.
//
//   node tools/heic-to-jpg.js "N:\사진"                 한 번 바꾸고 끝
//   node tools/heic-to-jpg.js "N:\사진" --watch        켜 두면 새 사진도 계속 바꿈
//   node tools/heic-to-jpg.js "N:\사진" --out "D:\jpg"  저장 위치를 직접 정함
//
// 옵션
//   --max 2400     긴 쪽이 이 값보다 크면 줄인다(기본: 줄이지 않음). 용량을 줄이고 싶을 때만.
//   --quality 90   JPG 품질 1~100 (기본 90)
//   --no-copy      HEIC 가 아닌 사진(JPG·PNG·WEBP)은 옮기지 않는다(기본: 같이 복사해서 폴더 하나로 모음)
//
// 바꾼 JPG 의 수정 시각은 원본과 같게 맞춘다. tools/blog-watch.js 가 사진을 "찍은 시각" 순으로
// 글 단위로 묶기 때문에, 이 값이 변환한 시각으로 바뀌면 묶음이 엉킨다.
// 라이브포토의 영상(MOV)은 쓰지 않으므로 건너뛴다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HEIC = /\.(heic|heif)$/i;
const PLAIN = /\.(jpe?g|png|webp)$/i;
const FOLDER = '네이버마이박스';
const POLL_MS = 30 * 1000;
const SETTLE_MS = 20 * 1000;     // 막 올라오는 중인 파일은 잠깐 두었다가 읽는다

// 바탕화면 위치. 한국 윈도우는 OneDrive 가 바탕화면을 가져가 "바탕 화면"(띄어쓰기)인 경우가 많다.
function desktopDir() {
  const home = os.homedir();
  const names = ['Desktop', '바탕 화면', '바탕화면'];
  const roots = [home, path.join(home, 'OneDrive')];
  for (const r of roots) for (const n of names) {
    const p = path.join(r, n);
    if (fs.existsSync(p)) return p;
  }
  return path.join(home, 'Desktop');   // 없으면 만들어서라도 여기에
}

function parseArgs(argv) {
  const o = { dir: null, flags: {} };
  const bool = ['watch', 'no-copy'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      o.flags[k] = bool.indexOf(k) >= 0 ? true : argv[++i];
    } else if (!o.dir) o.dir = a;
  }
  return o;
}

function walk(dir, skip, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (path.resolve(p) === skip) continue;
    if (e.isDirectory()) walk(p, skip, out);
    else if (HEIC.test(e.name) || PLAIN.test(e.name)) {
      try { const s = fs.statSync(p); out.push({ path: p, mtime: s.mtimeMs, size: s.size }); } catch (e2) { /* 지워진 파일 */ }
    }
  }
  return out;
}

async function main() {
  const { dir, flags } = parseArgs(process.argv.slice(2));
  const srcDir = dir || process.env.BLOG_WATCH_DIR;
  if (!srcDir || !fs.existsSync(srcDir)) {
    console.error('사진 폴더를 알려 주세요.\n  node tools/heic-to-jpg.js "N드라이브 사진 폴더 경로"');
    process.exit(1);
  }
  let heicConvert;
  try { heicConvert = require('heic-convert'); }
  catch (e) { console.error('heic-convert 가 없습니다. 프로젝트 폴더에서 npm install 을 해 주세요.'); process.exit(1); }
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { /* --max 를 쓸 때만 필요 */ }
  const maxEdge = Number(flags.max) || 0;
  if (maxEdge && !sharp) { console.error('--max 는 sharp 가 필요합니다. npm install 을 해 주세요.'); process.exit(1); }
  const quality = Math.min(100, Math.max(1, Number(flags.quality) || 90));

  const outDir = path.resolve(flags.out || path.join(desktopDir(), FOLDER));
  if (path.resolve(srcDir) === outDir) { console.error('저장 폴더가 원본 폴더와 같습니다. --out 으로 다른 곳을 정해 주세요.'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  console.log('원본: ' + srcDir + '\n저장: ' + outDir + (flags.watch ? '\n켜 두면 새 사진도 계속 바꿉니다. 끄려면 Ctrl+C' : ''));

  const failed = new Set();   // 한 번 실패한 파일은 이번 실행에서 다시 읽지 않는다(30초마다 같은 오류가 뜨는 것을 막음)

  async function pass() {
    const now = Date.now();
    let done = 0, skipped = 0, bad = 0;
    for (const f of walk(srcDir, outDir, [])) {
      if (now - f.mtime < SETTLE_MS || f.size === 0) continue;
      const rel = path.relative(srcDir, f.path);
      const isHeic = HEIC.test(f.path);
      if (!isHeic && flags['no-copy']) continue;
      const target = path.join(outDir, isHeic ? rel.replace(HEIC, '.jpg') : rel);
      const key = f.path + '|' + f.mtime;
      if (failed.has(key)) continue;
      try {
        const st = fs.existsSync(target) ? fs.statSync(target) : null;
        if (st && Math.abs(st.mtimeMs - f.mtime) < 2000) { skipped++; continue; }   // 이미 바꿔 둠
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let buf = fs.readFileSync(f.path);
        if (isHeic) buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: quality / 100 }));
        if (maxEdge && sharp) {
          buf = await sharp(buf).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .toFormat(isHeic || /jpe?g$/i.test(f.path) ? 'jpeg' : path.extname(f.path).slice(1).toLowerCase().replace('jpg', 'jpeg'),
              { quality }).toBuffer();
        }
        fs.writeFileSync(target, buf);
        fs.utimesSync(target, new Date(), new Date(f.mtime));
        done++;
        console.log('  ' + rel + (isHeic ? '  →  ' + path.relative(outDir, target) : '  (복사)') +
          '  ' + (f.size / 1048576).toFixed(1) + 'MB → ' + (buf.length / 1048576).toFixed(1) + 'MB');
      } catch (e) {
        failed.add(key); bad++;
        // 클라우드에만 있고 아직 내려받지 않은 파일, 아직 올라오는 중인 파일, 변환기가 못 읽는 형식이 대부분이다.
        console.error('  실패: ' + rel + ' — ' + String((e && e.message) || e).slice(0, 160));
      }
    }
    if (done || bad || !flags.watch) {
      console.log('바꾼 것 ' + done + '장, 이미 되어 있던 것 ' + skipped + '장' + (bad ? ', 실패 ' + bad + '장' : ''));
    }
    return bad;
  }

  if (!flags.watch) { process.exitCode = (await pass()) ? 2 : 0; return; }
  for (;;) {
    await pass();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();
module.exports = { desktopDir, FOLDER };
