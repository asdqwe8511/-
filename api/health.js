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
// 지금 어떤 모델로 풀이를 쓰는지. 값을 바꿔 놓고 안 바뀐 줄 아는 일을 막는다.
let sajuApi = {};
try { sajuApi = require('./saju.js'); } catch (e) { /* 키가 없어도 여기는 떠야 한다 */ }

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 응답 없음(' + ms + 'ms)')), ms))
  ]);
}

async function pingAnthropic() {
  if (!String(process.env.ANTHROPIC_API_KEY || '').trim()) return { configured: false };
  try {
    // saju.js 와 같은 방식으로 다듬어 쓴다. 여기서만 통하고 저기서는 안 통하면
    // 진단이 거짓말을 하게 된다.
    const client = new Anthropic({
      timeout: TIMEOUT_MS,
      apiKey: process.env.ANTHROPIC_API_KEY.trim().replace(/^["']|["']$/g, '')
    });
    // 모델 목록 조회는 요금이 붙지 않는다. 키가 살아 있는지만 본다.
    const list = await withTimeout(client.models.list({ limit: 1 }), TIMEOUT_MS, 'Anthropic');
    return { configured: true, working: true, sampleModel: list.data && list.data[0] && list.data[0].id };
  } catch (e) {
    const raw = String(e.message || '');
    // 키는 맞는데 잔액이 없는 경우가 가장 흔하다. "키가 틀렸다"고 하면 엉뚱한
    // 곳을 뒤지게 되므로 갈라서 말한다.
    let cause = null;
    if (/credit balance|billing|payment/i.test(raw)) {
      cause = '키는 맞습니다. Anthropic 계정에 잔액이 없습니다 — ' +
        'console.anthropic.com → Plans & Billing 에서 크레딧을 채우세요.';
    } else if (/authentication|api key|invalid x-api-key/i.test(raw)) {
      cause = '키가 틀렸거나 만료됐습니다. console.anthropic.com 에서 새로 발급해 넣으세요.';
    } else if (/rate limit|overloaded/i.test(raw)) {
      cause = '지금 요청이 몰려 있습니다. 잠시 뒤 다시 확인해 보세요.';
    }
    return { configured: true, working: false, error: raw, cause: cause };
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

// 이 앱이 쓰는 환경변수. 이 목록에 없는 이름은 넣어도 아무 일도 일어나지 않는다.
const WANTED = [
  'ANTHROPIC_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'SAJU_DAILY_LIMIT', 'SAJU_IP_HOURLY_LIMIT',
  'SAJU_IP_SALT', 'SAJU_MAX_SECONDS'
];

// 키가 안 보일 때 원인은 몇 가지뿐이다. 어느 것인지 짚어 주지 않으면 쓰는 사람은
// 같은 화면을 몇 번씩 다시 볼 수밖에 없다. 값은 절대 내보내지 않고, 이름과 모양만 본다.
function diagnose() {
  const raw = process.env.ANTHROPIC_API_KEY;
  const notes = [];

  const present = WANTED.filter((k) => process.env[k]);

  // 이름을 잘못 적은 경우를 잡는다. 이름만 보이고 값은 보이지 않는다.
  // 개발 도구가 심어 두는 변수(CLAUDE_CODE_*)까지 세면 목록이 쓸모없어지므로 뺀다.
  const nearMiss = Object.keys(process.env).filter((k) =>
    WANTED.indexOf(k) < 0 &&
    !/^CLAUDE_?CODE|^CLAUDE_(PID|EFFORT|SESSION|ENABLE|ADDITIONAL|AFTER|AUTO)/i.test(k) &&
    (/ANTHROPIC|ANTROPIC|ANTHROPHIC/i.test(k) || /API_?KEY$/i.test(k))
  ).sort().slice(0, 10);

  if (!raw) {
    if (nearMiss.length) {
      notes.push('ANTHROPIC_API_KEY 는 안 보이는데 비슷한 이름이 들어와 있습니다: ' +
        nearMiss.join(', ') + '. 이름은 정확히 ANTHROPIC_API_KEY 여야 합니다(대문자, 밑줄).');
    }
    notes.push('이 함수에 ANTHROPIC_API_KEY 가 닿지 않았습니다. 셋 중 하나입니다 — ' +
      '(1) 넣은 뒤 Redeploy 를 안 했다(환경변수는 이미 떠 있는 배포에 적용되지 않습니다), ' +
      '(2) 팀 공용 환경변수로 넣고 이 프로젝트에 연결하지 않았다("Link to Projects" 에서 프로젝트를 고르세요), ' +
      '(3) Environments 에서 이 함수가 도는 환경(아래 "이_함수가_도는_곳")을 체크하지 않았다.');
  } else {
    // 붙여넣다 따옴표나 공백이 딸려 오는 일이 잦다.
    const key = raw.trim();
    if (raw !== key) notes.push('값 앞이나 뒤에 공백이 붙어 있습니다. 다시 넣어 주세요.');
    if (/^["']|["']$/.test(raw)) notes.push('값이 따옴표로 감싸여 있습니다. 따옴표 없이 넣어 주세요.');
    if (!/^sk-ant-/.test(key)) notes.push('값이 sk-ant- 로 시작하지 않습니다. Anthropic 키가 아닐 수 있습니다.');
    if (key.length < 40) notes.push('값이 너무 짧습니다(' + key.length + '자). 잘려서 들어갔을 수 있습니다.');
  }

  return {
    // 값이 들어는 있는데 모양이 틀린 경우. 부르는 쪽에서 이것만 보고도 진단을 띄운다.
    모양이상: Boolean(raw) && notes.length > 0,
    이_함수가_도는_곳: process.env.VERCEL_ENV || '(Vercel 아님 — 로컬)',
    배포된_커밋: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || '(모름)',
    이_앱이_찾는_이름_중_들어온_것: present.length ? present : ['(하나도 없음)'],
    비슷한_이름: nearMiss.length ? nearMiss : ['(없음)'],
    짚이는_것: notes.length ? notes : ['환경변수 쪽에 이상은 없어 보입니다.']
  };
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
        anthropic.cause || '키가 틀렸거나 만료됐을 수 있습니다'),
      '사용량 제한': state(redis,
        'Upstash Redis 를 붙이지 않아 인스턴스별 메모리 제한만 걸립니다(공개 사이트에는 약합니다)',
        'URL 또는 토큰이 틀렸을 수 있습니다')
    },
    풀이_모델: {
      쓰는_중: sajuApi.MODEL_LABEL
        ? sajuApi.MODEL_LABEL + ' (' + sajuApi.MODEL + ')'
        : '(알 수 없음)',
      바꾸려면: 'SAJU_MODEL 환경변수에 ' +
        (sajuApi.MODEL_CHOICES || []).join(' / ') + ' 중 하나를 넣고 다시 배포하세요',
      값이_다르면: process.env.SAJU_MODEL && process.env.SAJU_MODEL !== sajuApi.MODEL
        ? 'SAJU_MODEL 에 "' + process.env.SAJU_MODEL + '" 이 들어 있는데 못 알아들어서 기본값으로 돕니다'
        : undefined
    },
    상한: {
      하루_총_풀이_횟수: Number(process.env.SAJU_DAILY_LIMIT || 300),
      한사람_시간당_횟수: Number(process.env.SAJU_IP_HOURLY_LIMIT || 10)
    },
    안내: deep
      ? '실제 연결까지 확인했습니다. 이 응답에 키 값은 들어 있지 않습니다.'
      : '키가 실제로 통하는지까지 보려면 /api/health?deep=1 을 열어 보세요.'
  };

  // 키가 없을 때, 연결이 안 될 때, 그리고 값 모양이 이상할 때 진단을 붙인다.
  // 공백·따옴표·잘림은 외부 호출 없이도 잡히므로 ?deep=1 을 기다릴 이유가 없다.
  const info = diagnose();
  if (!anthropic.configured || anthropic.working === false || info.모양이상) {
    delete info.모양이상;
    out.진단 = info;
  }
  if (deep && anthropic.sampleModel) out.안내 += ' (Anthropic 응답 확인: ' + anthropic.sampleModel + ')';

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
};
