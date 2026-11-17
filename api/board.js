// 불편 게시판 엔드포인트. 로그인 없이 누구나 포스트잇을 붙인다.
//
//   GET    /api/board                 최근 포스트잇 목록
//   POST   /api/board  {text,color}   새 포스트잇
//   POST   /api/board  {action:'agree',id}   "나도 불편해" +1 (IP 당 한 번)
//   DELETE /api/board?id=...          관리자 삭제 (헤더 x-admin-key = BOARD_ADMIN_KEY)
//
// 저장소는 Upstash Redis(사주 사용량 제한과 같은 환경변수). 없으면 서버 메모리에
// 담아 두는데, 배포 환경에서는 재시작되면 사라지므로 개발용이다.
// 글쓴이를 알 수 있는 값은 저장하지 않는다. IP 는 해시로만 쓰고 글에 붙이지 않는다.
const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX_LEN = 140;
const KEEP = 200;                                   // 보관하는 최대 장수
const SHOW = 100;                                   // 한 번에 보여 주는 장수
const IP_HOURLY_LIMIT = Number(process.env.BOARD_IP_HOURLY_LIMIT) || 10;
const COLORS = ['yellow', 'pink', 'blue', 'green'];

// ---- 저장소 ---------------------------------------------------------------
const mem = { notes: [], agree: {}, voters: {}, hits: {} };

async function redis(commands) {
  const res = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('Redis HTTP ' + res.status);
  return (await res.json()).map((r) => r.result);
}

const store = {
  persistent: !!(REDIS_URL && REDIS_TOKEN),

  async list() {
    if (!this.persistent) return { notes: mem.notes.slice(0, SHOW), agree: mem.agree };
    const [raw, agree] = await redis([['LRANGE', 'board:notes', 0, SHOW - 1], ['HGETALL', 'board:agree']]);
    const map = {};
    for (let i = 0; agree && i < agree.length; i += 2) map[agree[i]] = Number(agree[i + 1]);
    return { notes: raw.map((s) => JSON.parse(s)), agree: map };
  },

  async add(note) {
    if (!this.persistent) { mem.notes.unshift(note); mem.notes.length = Math.min(mem.notes.length, KEEP); return; }
    await redis([['LPUSH', 'board:notes', JSON.stringify(note)], ['LTRIM', 'board:notes', 0, KEEP - 1]]);
  },

  // 같은 IP 가 같은 글에 두 번 누르지 못하게 한다. 새로 올랐으면 true.
  async agree(id, voter) {
    if (!this.persistent) {
      const set = (mem.voters[id] = mem.voters[id] || new Set());
      if (set.has(voter)) return false;
      set.add(voter); mem.agree[id] = (mem.agree[id] || 0) + 1; return true;
    }
    const [added] = await redis([['SADD', 'board:v:' + id, voter], ['EXPIRE', 'board:v:' + id, 60 * 60 * 24 * 30]]);
    if (!added) return false;
    await redis([['HINCRBY', 'board:agree', id, 1]]);
    return true;
  },

  async remove(id) {
    if (!this.persistent) {
      mem.notes = mem.notes.filter((n) => n.id !== id); delete mem.agree[id]; return;
    }
    const raw = await redis([['LRANGE', 'board:notes', 0, KEEP - 1]]);
    const hit = raw[0].find((s) => { try { return JSON.parse(s).id === id; } catch (e) { return false; } });
    const cmds = [['HDEL', 'board:agree', id], ['DEL', 'board:v:' + id]];
    if (hit) cmds.unshift(['LREM', 'board:notes', 0, hit]);
    await redis(cmds);
  },

  // 시간당 IP 별 횟수. 넘으면 true.
  async tooMany(voter) {
    if (!this.persistent) {
      const now = Date.now();
      const list = (mem.hits[voter] || []).filter((t) => now - t < 3600e3);
      list.push(now); mem.hits[voter] = list;
      return list.length > IP_HOURLY_LIMIT;
    }
    const key = 'board:ip:' + new Date().toISOString().slice(0, 13) + ':' + voter;
    const [n] = await redis([['INCR', key], ['EXPIRE', key, 3700]]);
    return Number(n) > IP_HOURLY_LIMIT;
  }
};

// ---- 보조 -----------------------------------------------------------------
function voterOf(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update(ip + '|' + (process.env.SAJU_IP_SALT || 'board')).digest('hex').slice(0, 16);
}

// 제어문자를 걷어 내고 공백을 정리한다. 화면에서는 textContent 로만 쓰므로 HTML 은 실행되지 않는다.
function cleanText(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮]/g, '')
    .replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fail(res, code, message) { return res.status(code).json({ error: { message } }); }

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const { notes, agree } = await store.list();
      return res.status(200).json({
        persistent: store.persistent,
        notes: notes.map((n) => ({ id: n.id, text: n.text, color: n.color, t: n.t, agree: agree[n.id] || 0 }))
      });
    }

    if (req.method === 'DELETE') {
      const key = process.env.BOARD_ADMIN_KEY;
      const given = String(req.headers['x-admin-key'] || '');
      const a = Buffer.from(given), b = Buffer.from(key || '');
      if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 403, '권한이 없습니다.');
      const id = String((req.query && req.query.id) || '');
      if (!/^[a-z0-9]{6,32}$/.test(id)) return fail(res, 400, '잘못된 id 입니다.');
      await store.remove(id);
      return res.status(200).json({ ok: true });
    }

    if (req.method !== 'POST') return fail(res, 405, '지원하지 않는 요청입니다.');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const voter = voterOf(req);

    if (body.action === 'agree') {
      const id = String(body.id || '');
      if (!/^[a-z0-9]{6,32}$/.test(id)) return fail(res, 400, '잘못된 id 입니다.');
      return res.status(200).json({ ok: true, added: await store.agree(id, voter) });
    }

    const text = cleanText(body.text);
    if (!text) return fail(res, 400, '내용을 적어 주세요.');
    if ([...text].length > MAX_LEN) return fail(res, 400, MAX_LEN + '자까지 적을 수 있어요.');
    if (await store.tooMany(voter)) {
      res.setHeader('Retry-After', '600');
      return fail(res, 429, '너무 자주 붙이고 있어요. 조금 뒤에 다시 해 주세요.');
    }
    const note = {
      id: crypto.randomBytes(6).toString('hex'),
      text,
      color: COLORS.includes(body.color) ? body.color : COLORS[Math.floor(Math.random() * COLORS.length)],
      t: Date.now()
    };
    await store.add(note);
    return res.status(201).json({ ok: true, note: { ...note, agree: 0 } });
  } catch (e) {
    console.error('[board]', e.message);           // 글 내용은 로그에 남기지 않는다
    return fail(res, 500, '잠시 문제가 생겼어요. 다시 시도해 주세요.');
  }
}

module.exports = handler;
module.exports.cleanText = cleanText;
