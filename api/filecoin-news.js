// 파일코인(FIL) 관련 뉴스·SNS 글을 모아 텔레그램으로 보내는 엔드포인트.
//
// Vercel Cron 이 주기적으로 때리는 것을 전제로 한다(vercel.json 의 crons).
// 사람이 브라우저로 열어 확인할 수도 있게 두 가지 모드를 둔다.
//
//   /api/filecoin-news?key=<CRON_SECRET>          모아서 텔레그램으로 전송
//   /api/filecoin-news?key=<CRON_SECRET>&dry=1    모으기만 하고 전송은 안 함(JSON 으로 응답)
//   /api/filecoin-news?key=<CRON_SECRET>&test=1   텔레그램 연결만 확인(짧은 메시지 1통)
//
// dry=1 을 먼저 열어 보라고 만들었다. 출처가 살아 있는지, 몇 건이 잡히는지를
// 텔레그램을 더럽히지 않고 확인할 수 있다. 응답의 sources[] 에 출처별 성공/실패와
// 건수가 들어 있어서, 피드 주소가 죽으면 빈 결과가 아니라 실패로 드러난다.
//
// 비밀값(봇 토큰)은 서버 환경변수에만 둔다. 이 응답에도 절대 싣지 않는다.
//
//   TELEGRAM_BOT_TOKEN   @BotFather 가 준 토큰
//   TELEGRAM_CHAT_ID     받을 대화 id
//   CRON_SECRET          이 엔드포인트를 아무나 못 때리게 하는 열쇠(권장)
//   UPSTASH_REDIS_*      한 번 보낸 글을 다시 안 보내려고 쓴다(없으면 중복 전송됨)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const FETCH_TIMEOUT_MS = 12000;
const SEEN_TTL_SECONDS = 60 * 60 * 24 * 14;   // 2주. 그 뒤엔 어차피 시간창 밖이다.
const MAX_ITEMS_PER_RUN = 20;                 // 한 번에 쏟아 붓지 않는다
const TELEGRAM_LIMIT = 3800;                  // 실제 상한은 4096. 여유를 둔다.

// 붙일 출처들. kind 로 뉴스와 SNS 를 나눈다.
//
// X(트위터)는 넣지 못했다. 공식 API 가 유료고, nitter 류 대체 인스턴스는 수시로
// 죽어서 크론이 조용히 빈 결과를 내기 때문이다. 넣는다면 유료 키를 받아
// sources 에 한 줄 더 얹는 형태가 된다.
const SOURCES = [
  {
    id: 'news-ko',
    kind: '뉴스',
    label: '구글뉴스(한국어)',
    url: 'https://news.google.com/rss/search?q=%ED%8C%8C%EC%9D%BC%EC%BD%94%EC%9D%B8+OR+Filecoin&hl=ko&gl=KR&ceid=KR:ko',
    parse: parseRss
  },
  {
    id: 'news-en',
    kind: '뉴스',
    label: '구글뉴스(영어)',
    url: 'https://news.google.com/rss/search?q=Filecoin+OR+%24FIL&hl=en-US&gl=US&ceid=US:en',
    parse: parseRss
  },
  {
    id: 'blog',
    kind: '공식',
    label: 'Filecoin 블로그',
    url: 'https://filecoin.io/blog/feed/feed.xml',
    parse: parseRss
  },
  {
    id: 'reddit-sub',
    kind: 'SNS',
    label: 'r/filecoin',
    url: 'https://www.reddit.com/r/filecoin/new.json?limit=25',
    parse: parseReddit
  },
  {
    id: 'reddit-search',
    kind: 'SNS',
    label: '레딧 전체검색',
    url: 'https://www.reddit.com/search.json?q=Filecoin&sort=new&limit=25',
    parse: parseReddit
  }
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' 응답 없음(' + ms + 'ms)')), ms))
  ]);
}

async function fetchText(url) {
  // 레딧은 기본 UA 를 자주 막는다. 정체를 밝히는 UA 를 붙인다.
  const res = await withTimeout(
    fetch(url, { headers: { 'User-Agent': 'filecoin-news-bot/1.0 (+vercel cron)' } }),
    FETCH_TIMEOUT_MS, url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// --- 파싱 ---------------------------------------------------------------
// RSS 하나 때문에 XML 파서를 의존성으로 들이지 않는다. 이 피드들은 구조가
// 단순해서 정규식으로 충분하고, 깨진 항목은 버리면 그만이다.

function pickTag(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? decodeXml(m[1]) : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')          // 마지막에 풀어야 이중 인코딩이 안 깨진다
    .trim();
}

function parseRss(body) {
  const blocks = body.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) || [];
  return blocks.map((b) => {
    // Atom 은 <link href="..."/>, RSS 는 <link>...</link> 로 다르게 쓴다.
    const href = b.match(/<link[^>]*href=["']([^"']+)["']/);
    const link = href ? decodeXml(href[1]) : pickTag(b, 'link');
    const when = pickTag(b, 'pubDate') || pickTag(b, 'updated') || pickTag(b, 'published');
    const t = Date.parse(when);
    return {
      title: pickTag(b, 'title'),
      link,
      origin: pickTag(b, 'source'),           // 구글뉴스는 원매체명을 여기 넣어 준다
      ts: Number.isFinite(t) ? t : Date.now() // 날짜가 없으면 버리지 말고 지금으로 본다
    };
  }).filter((x) => x.title && x.link);
}

function parseReddit(body) {
  let json;
  try { json = JSON.parse(body); } catch (e) { throw new Error('JSON 아님'); }
  const children = (json && json.data && json.data.children) || [];
  return children.map((c) => {
    const d = c && c.data;
    if (!d || !d.title) return null;
    return {
      title: d.title,
      link: d.permalink ? 'https://www.reddit.com' + d.permalink : d.url,
      origin: d.subreddit_name_prefixed || 'reddit',
      ts: Number(d.created_utc) * 1000 || Date.now()
    };
  }).filter((x) => x && x.link);
}

// --- 수집 ---------------------------------------------------------------

// 제목이 같은 기사가 매체마다 올라온다. 기호·공백을 털어 같은 것끼리 묶는다.
function normTitle(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '').slice(0, 80);
}

function hashKey(s) {
  return require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 20);
}

async function collect(sinceMs) {
  const report = [];
  const results = await Promise.allSettled(SOURCES.map(async (s) => {
    const items = s.parse(await fetchText(s.url));
    return { s, items };
  }));

  const all = [];
  results.forEach((r, i) => {
    const s = SOURCES[i];
    if (r.status !== 'fulfilled') {
      // 한 출처가 죽어도 나머지는 보낸다. 대신 무엇이 죽었는지 남긴다.
      report.push({ id: s.id, label: s.label, ok: false, error: String(r.reason && r.reason.message || r.reason).slice(0, 120) });
      return;
    }
    const fresh = r.value.items.filter((x) => x.ts >= sinceMs);
    report.push({ id: s.id, label: s.label, ok: true, 받은건수: r.value.items.length, 기간내: fresh.length });
    fresh.forEach((x) => all.push(Object.assign({ kind: s.kind, via: s.label }, x)));
  });

  // 최신순으로 세운 뒤 제목 기준 중복 제거 — 먼저 온 쪽(=더 최신)이 남는다.
  all.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const unique = all.filter((x) => {
    const k = normTitle(x.title);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { items: unique, sources: report };
}

// --- 이미 보낸 것 걸러내기 ------------------------------------------------
// Redis 가 없으면 걸러내지 않는다. 크론이 돌 때마다 같은 기사가 다시 갈 수 있어서
// 조용히 넘기지 않고 응답에 표시한다.

async function redisPipeline(commands) {
  const res = await withTimeout(fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  }), FETCH_TIMEOUT_MS, 'redis');
  if (!res.ok) throw new Error('redis ' + res.status);
  return res.json();
}

async function dropAlreadySent(items) {
  if (!REDIS_URL || !REDIS_TOKEN) return { fresh: items, dedup: false };
  const keys = items.map((x) => 'filnews:seen:' + hashKey(normTitle(x.title)));
  try {
    const out = await redisPipeline(keys.map((k) => ['EXISTS', k]));
    const fresh = items.filter((_, i) => !(out[i] && Number(out[i].result) === 1));
    return { fresh, dedup: true };
  } catch (e) {
    // 중복 제거가 안 되는 것이 알림이 아예 안 가는 것보다는 낫다.
    console.error('[filnews] Redis 조회 실패, 중복 제거 생략:', e.message);
    return { fresh: items, dedup: false, degraded: e.message };
  }
}

async function markSent(items) {
  if (!REDIS_URL || !REDIS_TOKEN || !items.length) return;
  try {
    await redisPipeline(items.map((x) =>
      ['SETEX', 'filnews:seen:' + hashKey(normTitle(x.title)), SEEN_TTL_SECONDS, '1']));
  } catch (e) {
    console.error('[filnews] Redis 기록 실패:', e.message);
  }
}

// --- 텔레그램 -----------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMessages(items, hours) {
  const head = '<b>📦 파일코인(FIL) 소식</b> · 최근 ' + hours + '시간 · ' + items.length + '건\n';
  const lines = items.map((x, i) => {
    const when = new Date(x.ts).toISOString().slice(5, 16).replace('T', ' ');
    const where = esc(x.origin || x.via);
    return (i + 1) + '. [' + x.kind + '] <a href="' + esc(x.link) + '">' + esc(x.title) + '</a>\n'
         + '    <i>' + where + ' · ' + when + ' UTC</i>';
  });

  // 4096자 상한에 걸리면 잘려 나가는 게 아니라 전송 자체가 실패한다. 나눠 보낸다.
  const out = [];
  let buf = head;
  for (const line of lines) {
    if ((buf + '\n' + line).length > TELEGRAM_LIMIT) { out.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 없습니다');

  const res = await withTimeout(fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  }), FETCH_TIMEOUT_MS, 'telegram');

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    // 텔레그램은 실패 이유를 description 에 담아 준다. 토큰은 절대 싣지 않는다.
    throw new Error('telegram ' + res.status + ' ' + (body.description || ''));
  }
  return body;
}

// --- 핸들러 -------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  // 공개 주소이므로 열쇠를 요구한다. Vercel Cron 은 Authorization 헤더로 보내고,
  // 사람이 브라우저로 열 때는 ?key= 가 편하다. 둘 다 받는다.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = String((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
               || String((req.query && req.query.key) || '');
    if (given !== secret) { res.status(401).json({ ok: false, error: '인증 실패' }); return; }
  }

  const q = req.query || {};
  const dry = String(q.dry || '') === '1';
  const test = String(q.test || '') === '1';
  const hours = Math.min(Math.max(Number(q.hours) || 24, 1), 168);

  try {
    if (test) {
      await sendTelegram('✅ 연결 확인. 파일코인 알림이 이 대화로 옵니다.');
      res.status(200).json({ ok: true, mode: 'test', 전송: 1 });
      return;
    }

    const since = Date.now() - hours * 3600 * 1000;
    const { items, sources } = await collect(since);
    const { fresh, dedup, degraded } = await dropAlreadySent(items);
    const picked = fresh.slice(0, MAX_ITEMS_PER_RUN);

    if (dry) {
      res.status(200).json({
        ok: true, mode: 'dry', 안내: '전송하지 않았습니다.',
        시간창: hours + '시간', 중복제거: dedup ? 'Redis 사용' : '꺼짐(Redis 없음)',
        redis경고: degraded, sources,
        수집: items.length, 새것: fresh.length, 보낼것: picked.length,
        미리보기: picked.map((x) => ({ kind: x.kind, via: x.via, title: x.title, link: x.link,
                                       시각: new Date(x.ts).toISOString() }))
      });
      return;
    }

    if (!picked.length) {
      res.status(200).json({ ok: true, 전송: 0, 안내: '새 소식이 없어 보내지 않았습니다.', sources });
      return;
    }

    const chunks = formatMessages(picked, hours);
    for (const c of chunks) await sendTelegram(c);
    await markSent(picked);

    res.status(200).json({ ok: true, 전송: chunks.length, 건수: picked.length,
                           중복제거: dedup ? 'Redis 사용' : '꺼짐(Redis 없음)', sources });
  } catch (e) {
    console.error('[filnews]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
