// 네이버 블로그 글쓰기 도우미 엔드포인트.
//
// 두 단계를 한 함수가 맡는다.
//   mode: 'draft'    사진(+메모)을 받아 블로그 초안을 쓴다.
//   mode: 'rewrite'  초안과 "내 생각" 메모를 받아, 생각을 녹여 처음부터 다시 쓴다.
//
// 응답은 스트리밍(text/plain)이다. 사진과 글은 서버에 저장하지 않고 로그에도 남기지
// 않는다 — 요청을 모델에 넘기고 흘려보낸 뒤 버린다.
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;

// 사진을 읽는 글쓰기라 사고 과정은 켜지 않는다. 비전을 받는 모델만 허용한다.
const MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];
const DEFAULT_MODEL = 'claude-sonnet-5';
function pickModel() {
  const want = String(process.env.BLOG_MODEL || '').trim();
  if (!want) return DEFAULT_MODEL;
  if (MODELS.indexOf(want) >= 0) return want;
  console.error('[blog] BLOG_MODEL 값을 모르겠습니다: ' + want +
    ' — 쓸 수 있는 것: ' + MODELS.join(', ') + '. 기본값 ' + DEFAULT_MODEL + ' 으로 돕니다.');
  return DEFAULT_MODEL;
}
const MODEL = pickModel();

// ── 사용량 제한 ────────────────────────────────────────────────────────────
// 사주 풀이(api/saju.js)와 같은 방식이되 카운터 이름만 따로 쓴다. 한쪽이 몰려도
// 다른 쪽 분량이 깎이지 않게 하려는 것이다. Redis 가 없거나 죽으면 통과시킨다.
//   BLOG_DAILY_LIMIT       하루 총 호출 수 (기본 200)
//   BLOG_IP_HOURLY_LIMIT   한 사람이 한 시간에 부를 수 있는 횟수 (기본 20)
//                          글 한 편이 초안 1번 + 다시 쓰기 몇 번이라 사주보다 넉넉하다.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DAILY_LIMIT = Number(process.env.BLOG_DAILY_LIMIT || 200);
const IP_HOURLY_LIMIT = Number(process.env.BLOG_IP_HOURLY_LIMIT || 20);

const LOCAL_WINDOW_MS = 60 * 60 * 1000;
const localHits = new Map();
function locallyRateLimited(ip) {
  const now = Date.now();
  const list = (localHits.get(ip) || []).filter((t) => now - t < LOCAL_WINDOW_MS);
  list.push(now);
  localHits.set(ip, list);
  if (localHits.size > 5000) localHits.clear();
  return list.length > IP_HOURLY_LIMIT;
}

function ipKey(ip) {
  return require('crypto').createHash('sha256')
    .update(ip + '|' + (process.env.SAJU_IP_SALT || 'saju')).digest('hex').slice(0, 16);
}

async function checkQuota(ip) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return locallyRateLimited(ip) ? { ok: false, reason: 'ip', retryAfter: 600 } : { ok: true };
  }
  const now = new Date();
  const dayKey = 'blog:day:' + now.toISOString().slice(0, 10);
  const hourKey = 'blog:ip:' + now.toISOString().slice(0, 13) + ':' + ipKey(ip);
  try {
    const res = await fetch(REDIS_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', dayKey], ['EXPIRE', dayKey, 172800],
        ['INCR', hourKey], ['EXPIRE', hourKey, 7200]
      ])
    });
    if (!res.ok) throw new Error('redis ' + res.status);
    const out = await res.json();
    const dayCount = Number(out[0] && out[0].result);
    const ipCount = Number(out[2] && out[2].result);
    if (Number.isFinite(ipCount) && ipCount > IP_HOURLY_LIMIT) return { ok: false, reason: 'ip', retryAfter: 600 };
    if (Number.isFinite(dayCount) && dayCount > DAILY_LIMIT) return { ok: false, reason: 'day', retryAfter: 3600 };
    return { ok: true };
  } catch (e) {
    console.error('[blog-quota] Redis 확인 실패, 통과시킴:', e.message);
    return { ok: true };
  }
}

// ── 요청 검증 ──────────────────────────────────────────────────────────────
const TOPICS = ['맛집', '카페', '여행', '육아', '일상', '제품 리뷰', '기타'];
const TONES = {
  friendly: '친근한 "~했어요" 체. 이웃에게 이야기하듯 부드럽게.',
  plain: '담백한 "~했다" 체. 군더더기 없이 차분하게.',
  lively: '발랄한 "~했어요" 체. 가벼운 감탄과 이모지를 아껴서 한두 개만.'
};
const LENGTHS = {
  short: '공백 제외 약 900자',
  normal: '공백 제외 약 1,600자',
  long: '공백 제외 약 2,600자'
};
const MAX_IMAGES = 6;
const MAX_IMAGE_CHARS = 1400000;   // base64 한 장 상한
const MAX_TOTAL_CHARS = 4000000;   // Vercel 요청 본문 한도(4.5MB) 아래로
const DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

function validate(body) {
  const mode = body.mode === 'rewrite' ? 'rewrite' : 'draft';
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  const out = {
    mode: mode,
    topic: TOPICS.indexOf(body.topic) >= 0 ? body.topic : '기타',
    keyword: text(body.keyword, 80),
    tone: TONES[body.tone] ? body.tone : 'friendly',
    length: LENGTHS[body.length] ? body.length : 'normal',
    notes: text(body.notes, 3000),
    draft: text(body.draft, 12000),
    images: []
  };

  if (mode === 'draft') {
    const imgs = Array.isArray(body.images) ? body.images : [];
    if (imgs.length > MAX_IMAGES) return { error: '사진은 ' + MAX_IMAGES + '장까지 올릴 수 있습니다.' };
    let total = 0;
    for (const s of imgs) {
      const m = typeof s === 'string' ? DATA_URL.exec(s) : null;
      if (!m) return { error: '지원하지 않는 사진 형식입니다. JPG·PNG·WEBP 사진을 올려 주세요.' };
      if (m[2].length > MAX_IMAGE_CHARS) return { error: '사진 한 장이 너무 큽니다. 다시 올려 주세요.' };
      total += m[2].length;
      out.images.push({ media_type: m[1], data: m[2] });
    }
    if (total > MAX_TOTAL_CHARS) return { error: '사진 용량이 너무 큽니다. 장수를 줄이거나 다시 올려 주세요.' };
    if (!out.images.length && !out.notes) return { error: '사진을 올리거나 메모를 적어 주세요.' };
  } else {
    if (!out.draft) return { error: '다시 쓸 글이 비어 있습니다. 먼저 초안을 만들어 주세요.' };
    if (!out.notes) return { error: '내 생각을 적어 주세요. 그래야 글에 녹여 쓸 수 있습니다.' };
  }
  return { value: out };
}

// ── 프롬프트 ───────────────────────────────────────────────────────────────
// 두 단계가 같은 출력 모양을 쓴다. 다시 쓰기가 초안의 구조를 그대로 이어받게 하려는 것이다.
const FORMAT = `출력 형식 (이 순서, 이 모양 그대로):

제목 후보
1. ...
2. ...
3. ...

본문
(도입 2~3문장 → 소제목별 단락 → 마무리)

해시태그
#... #... (8~10개, 지역·핵심어 위주)

본문 규칙:
- 네이버 스마트에디터에 그대로 붙여넣을 글이다. 마크다운 기호(#, **, -, >, 표)를 쓰지 않는다.
  소제목은 "■ 소제목" 한 줄로 쓴다.
- 사진이 들어갈 자리는 해당 문단 앞에 "[사진1]" 처럼 번호만 단독 한 줄로 쓴다. 번호는 올린 순서다.
- 모바일에서 읽으므로 한 문단은 2~4문장, 문단 사이는 한 줄 비운다.
- 제목과 도입 첫 문장에 핵심 키워드(지역+주제)를 자연스럽게 넣는다. 키워드를 억지로 반복하지 않는다.
- 광고 문구처럼 과장하지 않는다("인생 맛집", "무조건 가야 하는 곳" 금지).`;

const SYSTEM_DRAFT = `당신은 네이버 블로그 글을 대신 초안으로 잡아 주는 에디터입니다.
글쓴이가 올린 사진과 메모로 블로그 초안을 씁니다. 이 초안은 글쓴이가 자기 생각을 얹어 다시 고칠 뼈대입니다.

${FORMAT}

사실 규칙 (가장 중요):
- 사진에서 실제로 보이는 것(음식·장소·분위기·사진 속 글씨)과 글쓴이 메모에 적힌 것만 쓴다.
- 사진이나 메모에 없는 상호명, 주소, 가격, 영업시간, 메뉴 구성은 지어내지 않는다.
  필요하면 "(확인 필요: 가격)" 처럼 괄호로 표시해 두어 글쓴이가 채우게 한다.
- 맛·향·식감·만족도처럼 먹어 봐야 아는 것을 글쓴이 대신 단정하지 않는다.
  그런 곳에는 "(내 생각 자리: 맛은 어땠는지)" 처럼 글쓴이가 채울 자리를 1~3곳 남기고,
  그 앞뒤는 사진에서 보이는 사실만으로 자연스럽게 이어 쓴다.
- 메모에 "협찬", "체험단", "제공받아" 같은 말이 있으면 본문 맨 앞에 광고 표기 문장을 한 줄 넣는다.
- 사진 속에 사람 얼굴이나 개인정보(번호판, 영수증의 카드번호 등)가 보여도 글에 옮기지 않는다.`;

const SYSTEM_REWRITE = `당신은 네이버 블로그 글을 글쓴이의 목소리로 다듬는 에디터입니다.
초안과 글쓴이의 "내 생각" 메모를 받아, 생각이 글 전체에 녹아 있는 최종 글로 처음부터 다시 씁니다.

${FORMAT}

다시 쓰기 규칙 (가장 중요):
- 글쓴이의 의견은 방향과 세기를 그대로 살린다. 부정적인 평가를 긍정으로 바꾸거나,
  강한 표현을 밋밋하게 순화하거나, 아쉬운 점을 빼지 않는다.
- 메모의 생각은 글에서 가장 어울리는 단락에 1인칭으로 넣는다. 한 곳에 몰아 붙이지 않는다.
- 초안의 "(내 생각 자리: ...)" 는 메모로 채우고 모두 지운다. 메모에 답이 없는 자리는
  그 문장을 사실 서술로 바꾸거나 자연스럽게 빼서, 빈 칸이 남지 않게 한다.
- 초안과 메모에 없는 경험, 감정, 사실을 새로 만들어 넣지 않는다.
  "(확인 필요: ...)" 표시는 메모에서 해결되지 않았다면 그대로 둔다.
- 초안의 [사진N] 위치와 순서는 유지한다. 단락 흐름이 더 자연스러워지면 옮겨도 되지만 번호는 바꾸지 않는다.
- 메모 중 글에 넣지 못한 것이 있으면 맨 끝에 "[반영 못 한 메모] ..." 한 줄로만 알린다. 없으면 이 줄을 쓰지 않는다.`;

function buildUser(input) {
  const parts = [];
  const head = '주제: ' + input.topic +
    (input.keyword ? '\n핵심 키워드(지역+주제): ' + input.keyword : '') +
    '\n말투: ' + TONES[input.tone] +
    '\n분량: ' + LENGTHS[input.length];

  if (input.mode === 'draft') {
    if (input.images.length) {
      parts.push({ type: 'text', text: '아래 사진 ' + input.images.length + '장은 올린 순서대로 [사진1]부터입니다.' });
      input.images.forEach((img, i) => {
        parts.push({ type: 'text', text: '[사진' + (i + 1) + ']' });
        parts.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      });
    }
    parts.push({ type: 'text', text: head +
      (input.notes ? '\n\n글쓴이 메모(확실한 정보):\n' + input.notes : '') +
      '\n\n위 정보로 블로그 초안을 써 주세요.' });
  } else {
    parts.push({ type: 'text', text: head +
      '\n\n[초안]\n' + input.draft +
      '\n\n[내 생각 메모]\n' + input.notes +
      '\n\n메모의 생각이 글 전체에 녹아들도록 다시 써 주세요.' });
  }
  return parts;
}

// ── 오류 안내 ──────────────────────────────────────────────────────────────
function fail(res, code, message) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).json({ error: { message } });
}

function explainApiError(e) {
  const raw = String((e && e.message) || '');
  const status = (e && (e.status || e.statusCode)) || 0;
  const owner = ' 사이트 주인이 확인해야 하는 문제라, 잠시 뒤 다시 열어 봐 주세요.';
  if (/credit balance|billing|quota|payment/i.test(raw)) {
    return { status: 503, reason: '잔액/결제', message: '글쓰기 기능이 잠시 멈춰 있습니다.' + owner };
  }
  if (status === 401 || status === 403 || /authentication|api key|permission/i.test(raw)) {
    return { status: 503, reason: '인증', message: '글쓰기 기능 설정에 문제가 있습니다.' + owner };
  }
  if (status === 429 || status === 529 || /rate limit|overloaded/i.test(raw)) {
    return { status: 503, reason: '혼잡', message: '지금 요청이 몰려 잠시 밀렸습니다. 1~2분 뒤에 다시 눌러 주세요.' };
  }
  if (status === 400 && /image/i.test(raw)) {
    return { status: 400, reason: '사진', message: '사진을 읽지 못했습니다. 다른 사진으로 바꿔 다시 올려 주세요.' };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(raw)) {
    return { status: 504, reason: '시간초과', message: '글을 받아 오다 연결이 끊겼습니다. 다시 눌러 주세요.' };
  }
  return { status: 502, reason: '알수없음', message: '글을 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요.' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'POST 로 요청해 주세요.');
  if (!String(process.env.ANTHROPIC_API_KEY || '').trim()) {
    return fail(res, 503,
      '아직 글쓰기 기능이 켜지지 않았습니다. 사이트 주인이 Vercel 환경변수에 ANTHROPIC_API_KEY 를 넣고 ' +
      '다시 배포(Redeploy)하면 켜집니다. 무엇이 걸렸는지는 /api/health 를 열면 짚어 줍니다.');
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return fail(res, 400, '요청 형식이 올바르지 않습니다.'); }
  }
  if (!body || typeof body !== 'object') return fail(res, 400, '요청 본문이 비어 있습니다.');

  const checked = validate(body);
  if (checked.error) return fail(res, 400, checked.error);
  const input = checked.value;

  // 형식이 틀린 요청이 분량을 깎지 않도록, 검증을 통과한 뒤에 센다.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const quota = await checkQuota(ip);
  if (!quota.ok) {
    res.setHeader('Retry-After', String(quota.retryAfter || 600));
    return fail(res, 429, quota.reason === 'day'
      ? '오늘 준비된 글쓰기 분량이 모두 나갔습니다. 내일 다시 찾아와 주세요.'
      : '조금 빠르게 여러 번 요청하셨습니다. 10분쯤 뒤에 다시 시도해 주세요.');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  // 플랫폼이 함수를 끊기 전에 먼저 멈춘다. vercel.json 의 maxDuration 과 맞춘다.
  const BUDGET_MS = (Number(process.env.BLOG_MAX_SECONDS) || 60) * 1000 - 4000;
  const startedAt = Date.now();

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY.trim().replace(/^["']|["']$/g, '')
  });
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 6000,
      system: input.mode === 'rewrite' ? SYSTEM_REWRITE : SYSTEM_DRAFT,
      messages: [{ role: 'user', content: buildUser(input) }]
    });

    let cutShort = false;
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(event.delta.text);
      }
      if (Date.now() - startedAt > BUDGET_MS) {
        cutShort = true;
        try { if (typeof stream.abort === 'function') stream.abort(); } catch (e2) { /* 무시 */ }
        break;
      }
    }
    if (cutShort) {
      res.write('\n\n(글이 길어져 여기서 멈췄습니다. 분량을 "짧게"로 바꾸거나 사진 수를 줄여 다시 받아 보세요.)');
      res.end();
      return;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      res.write('\n\n(글을 이어가지 못했습니다. 사진이나 메모를 조금 바꿔 다시 시도해 주세요.)');
    }
    res.end();
  } catch (e) {
    // 사진·글 내용은 로그에 남기지 않는다. 오류 원문 앞부분만 남긴다.
    const friendly = explainApiError(e);
    console.error('[blog] 실패:', friendly.reason, '—',
      (e && e.message ? String(e.message) : '알 수 없는 오류').slice(0, 300));
    if (res.headersSent) {
      res.write('\n\n(' + friendly.message + ')');
      res.end();
    } else {
      fail(res, friendly.status, friendly.message);
    }
  }
};

module.exports.MODEL = MODEL;
module.exports.TONES = Object.keys(TONES);
module.exports.LENGTHS = Object.keys(LENGTHS);
module.exports.TOPICS = TOPICS;
// 내 PC 에서 도는 tools/blog-watch.js 가 같은 프롬프트로 초안을 쓰게 한다.
// 프롬프트가 두 군데로 갈라지면 사이트와 폴더 감시의 글 모양이 달라진다.
module.exports.draftRequest = (input) => ({
  model: MODEL,
  max_tokens: 6000,
  system: SYSTEM_DRAFT,
  messages: [{ role: 'user', content: buildUser(Object.assign(
    { mode: 'draft', images: [], notes: '', topic: '기타', keyword: '', tone: 'friendly', length: 'normal' }, input)) }]
});
