#!/usr/bin/env node
// PC에서 이 사이트를 그대로 띄우는 개발 서버.
//
//   node tools/dev-server.js          → http://localhost:3000
//   PORT=8080 node tools/dev-server.js
//
// Vercel 없이도 돌아가도록, 정적 파일 서빙과 api/ 아래 함수 호출을 둘 다 한다.
// 배포 환경(Vercel)이 해 주던 일 중 여기서 흉내 내는 것은 세 가지다.
//   · 확장자 없는 주소(/saju → saju.html)
//   · req.query 파싱
//   · JSON 본문을 req.body 로 미리 파싱
// 의존성은 없다. 해석 기능만 @anthropic-ai/sdk 가 필요하다(npm install).
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.resolve(__dirname, '..');

// .env 가 있으면 읽어 온다. 세션마다 환경변수를 다시 잡아 주는 것보다 파일 하나
// 두는 편이 편하다(특히 윈도우). .env 는 .gitignore 에 있어 커밋되지 않는다.
(function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  });
  console.log('  .env 를 읽었습니다.');
})();

const PORT = process.env.PORT || 3000;

// vercel.json 의 redirects 를 그대로 흉내 낸다. 여기서 안 되면 로컬에서 확인한 것이
// 배포와 달라진다(예전 /saju 주소가 로컬에서만 404 가 되는 식으로).
const REDIRECTS = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return Array.isArray(cfg.redirects) ? cfg.redirects : [];
  } catch (e) { return []; }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

// api/ 아래에서 요청 경로에 맞는 핸들러 파일을 찾는다.
// /api/saju        → api/saju.js
// /api/yt/videos   → api/yt/videos.js 가 없으면 api/yt/[...path].js
function findHandler(pathname) {
  const rel = pathname.replace(/^\/api\/?/, '');
  const direct = path.join(ROOT, 'api', rel + '.js');
  if (fs.existsSync(direct)) return direct;

  const parts = rel.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const dir = path.join(ROOT, 'api', ...parts.slice(0, i));
    if (!fs.existsSync(dir)) continue;
    const catchAll = fs.readdirSync(dir).find((f) => /^\[\.\.\..+\]\.js$/.test(f));
    if (catchAll) return path.join(dir, catchAll);
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      const type = req.headers['content-type'] || '';
      if (type.indexOf('application/json') >= 0) {
        try { return resolve(JSON.parse(raw)); } catch (e) { return resolve(raw); }
      }
      resolve(raw);
    });
  });
}

async function serveApi(req, res, parsed) {
  const file = findHandler(parsed.pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '해당 API 경로가 없습니다: ' + parsed.pathname } }));
    return;
  }
  // 고치는 즉시 반영되도록 매번 새로 읽는다.
  delete require.cache[require.resolve(file)];
  const handler = require(file);

  req.query = parsed.query;
  req.body = await readBody(req);

  // Vercel 의 res.status().json() 을 노드 기본 응답에 얹는다.
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };

  try {
    await handler(req, res);
  } catch (e) {
    console.error('[api]', parsed.pathname, e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
}

function serveStatic(req, res, parsed) {
  const hit = REDIRECTS.find((r) => r.source === parsed.pathname);
  if (hit) {
    res.writeHead(hit.permanent ? 308 : 307, { Location: hit.destination });
    res.end();
    return;
  }
  let rel = decodeURIComponent(parsed.pathname);
  if (rel === '/') rel = '/index.html';
  if (!path.extname(rel)) rel += '.html';           // /saju → /saju.html

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — ' + rel + ' 을 찾을 수 없습니다.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'   // 고친 파일이 바로 보이도록
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname.startsWith('/api/')) return serveApi(req, res, parsed);
  serveStatic(req, res, parsed);
});

// 포트가 이미 쓰이고 있는 건 흔한 일이다. 스택 트레이스를 던지는 대신
// 무엇을 하면 되는지 알려 준다.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  ' + PORT + '번 포트를 이미 다른 프로그램이 쓰고 있습니다.');
    console.error('  다른 포트로 띄우세요:  PORT=' + (Number(PORT) + 1) + ' node tools/dev-server.js');
    console.error('  (윈도우 명령 프롬프트라면)  set PORT=' + (Number(PORT) + 1) + ' && node tools/dev-server.js\n');
  } else if (e.code === 'EACCES') {
    console.error('\n  ' + PORT + '번 포트를 열 권한이 없습니다. 1024보다 큰 포트를 써 주세요.\n');
  } else {
    console.error('\n  서버를 시작하지 못했습니다: ' + e.message + '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n  사주 앱           http://localhost:' + PORT + '/');
  console.log('  인기영상 대시보드 http://localhost:' + PORT + '/youtube');
  console.log('  차트 기법 보기    http://localhost:' + PORT + '/trading\n');
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY (사주 해석 문장)');
  if (!process.env.YOUTUBE_API_KEY) missing.push('YOUTUBE_API_KEY (인기영상 대시보드)');
  if (missing.length) {
    console.log('  환경변수가 없어 아래 기능은 꺼집니다:');
    missing.forEach((m) => console.log('    - ' + m));
    console.log('  프로젝트 폴더에 .env 파일을 만들어 두면 읽어 갑니다. 예)');
    console.log('    ANTHROPIC_API_KEY=sk-ant-...');
    console.log('  사주표·오행·대운·이름·시기 계산은 키 없이도 전부 동작합니다.\n');
  }
});
