// 설정 점검 엔드포인트.  사이트주소/api/health 를 브라우저로 열면 어떤 환경변수가
// 들어갔고 무엇이 켜졌는지 한눈에 보인다. 배포 후 "왜 풀이가 안 나오지"를
// 로그를 뒤지지 않고 확인하려고 둔다.
//
//   /api/health          키가 들어 있는지만 확인 (외부 호출 없음)
//   /api/health?deep=1   키가 실제로 통하는지까지 확인 (Anthropic 모델 목록 조회,
//                        Redis PING — 둘 다 요금이 붙지 않는 호출이다)
//
// 값 자체는 절대 내보내지 않는다. 들어 있는지 여부와, 비밀이 아닌 상한 숫자만 알린다.
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 응답 없음(' + ms + 'ms)')), ms))
  ]);
}

async function pingAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return { configured: false };
  try {
    const client = new Anthropic({ timeout: TIMEOUT_MS });
    // 모델 목록 조회는 요금이 붙지 않는다. 키가 살아 있는지만 본다.
    const list = await withTimeout(client.models.list({ limit: 1 }), TIMEOUT_MS, 'Anthropic');
    return { configured: true, working: true, sampleModel: list.data && list.data[0] && list.data[0].id };
  } catch (e) {
    return { configured: true, working: false, error: e.message };
  }
}

async function pingRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { configured: false };
  try {
    const res = await withTimeout(
      fetch(url + '/ping', { headers: { Authorization: 'Bearer ' + token } }),
      TIMEOUT_MS, 'Upstash');
    if (!res.ok) return { configured: true, working: false, error: 'HTTP ' + res.status };
    const body = await res.json();
    return { configured: true, working: body && body.result === 'PONG' };
  } catch (e) {
    return { configured: true, working: false, error: e.message };
  }
}

module.exports = async (req, res) => {
  const deep = String((req.query && req.query.deep) || '') === '1';
  const has = (k) => Boolean(process.env[k]);

  const anthropic = deep ? await pingAnthropic() : { configured: has('ANTHROPIC_API_KEY') };
  const redis = deep ? await pingRedis()
                     : { configured: has('UPSTASH_REDIS_REST_URL') && has('UPSTASH_REDIS_REST_TOKEN') };

  const state = (info, offMsg, brokenMsg) => {
    if (!info.configured) return '꺼짐 — ' + offMsg;
    if (info.working === false) {
      // 원인은 보여 주되 응답 본문을 통째로 쏟지는 않는다.
      const detail = String(info.error || '').replace(/\s+/g, ' ').slice(0, 140);
      return '설정은 됐지만 연결 실패 — ' + brokenMsg + ' (' + detail + ')';
    }
    if (info.working === true) return '동작';
    return '키는 들어 있음 (?deep=1 로 실제 연결까지 확인)';
  };

  const out = {
    ok: true,
    확인시각: new Date().toISOString(),
    기능: {
      '사주·오행·대운·시기·이름·궁합 계산': '동작 — 브라우저에서 계산하므로 키가 필요 없습니다',
      '풀이 문장(Claude)': state(anthropic,
        'Vercel 환경변수에 ANTHROPIC_API_KEY 를 넣고 Redeploy 하세요',
        '키가 틀렸거나 만료됐을 수 있습니다'),
      '인기영상 대시보드': has('YOUTUBE_API_KEY')
        ? '동작' : '꺼짐 — YOUTUBE_API_KEY 를 넣고 Redeploy 하세요',
      '사용량 제한': state(redis,
        'Upstash Redis 를 붙이지 않아 인스턴스별 메모리 제한만 걸립니다(공개 사이트에는 약합니다)',
        'URL 또는 토큰이 틀렸을 수 있습니다')
    },
    상한: {
      하루_총_풀이_횟수: Number(process.env.SAJU_DAILY_LIMIT || 300),
      한사람_시간당_횟수: Number(process.env.SAJU_IP_HOURLY_LIMIT || 10)
    },
    안내: deep
      ? '실제 연결까지 확인했습니다. 이 응답에 키 값은 들어 있지 않습니다.'
      : '키가 실제로 통하는지까지 보려면 /api/health?deep=1 을 열어 보세요.'
  };
  if (deep && anthropic.sampleModel) out.안내 += ' (Anthropic 응답 확인: ' + anthropic.sampleModel + ')';

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
};
