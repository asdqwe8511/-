const crypto = require('crypto');

// Only these YouTube Data API v3 endpoints can be reached through this proxy —
// keeps this from becoming an open relay for arbitrary googleapis.com paths.
const ALLOWED_ENDPOINTS = new Set(['videos', 'videoCategories', 'channels']);

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function isValidSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (!token) return false;

  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return false;

  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  if (!isValidSession(req)) {
    res.status(401).json({ error: { message: '로그인이 필요합니다.' } });
    return;
  }

  const pathParam = req.query.path;
  const segments = Array.isArray(pathParam) ? pathParam : [pathParam];
  const endpoint = segments[0];

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    res.status(400).json({ error: { message: '허용되지 않은 API 경로입니다.' } });
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: '서버에 YOUTUBE_API_KEY 환경변수가 설정되지 않았습니다.' } });
    return;
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(req.query).forEach(([k, v]) => {
    if (k === 'path') return; // Vercel's catch-all route param, not a real YouTube param
    url.searchParams.set(k, Array.isArray(v) ? v[0] : v);
  });
  url.searchParams.set('key', apiKey);

  try {
    const ytRes = await fetch(url);
    const data = await ytRes.json();
    res.status(ytRes.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
