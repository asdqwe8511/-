const crypto = require('crypto');

// 30 days
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(payload, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
    return;
  }

  const sitePassword = process.env.SITE_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!sitePassword || !sessionSecret) {
    res.status(500).json({
      error: '서버에 SITE_PASSWORD / SESSION_SECRET 환경변수가 설정되지 않았습니다. Vercel 프로젝트 설정에서 추가해주세요.',
    });
    return;
  }

  // Vercel's Node runtime parses JSON bodies into req.body automatically.
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';

  const a = Buffer.from(password);
  const b = Buffer.from(sitePassword);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    return;
  }

  const token = sign({ exp: Date.now() + SESSION_TTL_MS }, sessionSecret);
  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  res.status(200).json({ ok: true });
};
