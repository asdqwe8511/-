// 사주·이름 해석 엔드포인트.
//
// 계산은 서버에서 saju-engine.js 로 직접 한다. 클라이언트가 계산한 결과를 받아
// 그대로 프롬프트에 넣으면, 조작된 값이나 프롬프트 문구가 그대로 모델에게
// 전달된다. 여기서 받는 것은 생년월일·성별·이름 같은 원자료뿐이고, 전부
// 형식 검증을 통과해야 한다(자유 문장이 프롬프트에 닿는 경로가 없다).
//
// 응답은 스트리밍(text/plain)이다. 사주표는 브라우저가 같은 엔진으로 즉시
// 그리고, 해석 문장만 흘려보낸다.
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const SajuEngine = require('../saju-engine.js');

const MODEL = 'claude-opus-5';

// 한 인스턴스 안에서만 유효한 최소한의 브레이크. 서버리스라 완벽한 제한은
// 아니고, 실수나 단순 반복 호출로 요금이 새는 것을 막는 용도다.
const RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 20 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // 메모리 방어
  return list.length > RATE_LIMIT.max;
}

const HANGUL = /^[가-힣]{1,5}$/;
const HANJA = /^[㐀-䶿一-鿿]{1,5}$/;
const FOCUS = ['총운', '성격', '직업·적성', '재물', '건강', '인간관계'];

function fail(res, code, message) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).json({ error: { message } });
}

function validate(body) {
  const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  const year = int(body.year), month = int(body.month), day = int(body.day);
  if (year === null || year < 1900 || year > 2100) return { error: '생년은 1900~2100년만 계산합니다.' };
  if (month === null || month < 1 || month > 12) return { error: '월이 올바르지 않습니다.' };
  if (day === null || day < 1 || day > 31) return { error: '일이 올바르지 않습니다.' };

  const hasHour = body.hour !== null && body.hour !== undefined;
  const hour = hasHour ? int(body.hour) : null;
  const minute = hasHour ? (int(body.minute) === null ? 0 : int(body.minute)) : null;
  if (hasHour && (hour === null || hour < 0 || hour > 23)) return { error: '시가 올바르지 않습니다.' };
  if (hasHour && (minute < 0 || minute > 59)) return { error: '분이 올바르지 않습니다.' };

  if (body.gender !== '남' && body.gender !== '여') return { error: '성별을 선택해 주세요.' };
  if (body.calendar !== '양력' && body.calendar !== '음력') return { error: '달력 구분이 올바르지 않습니다.' };

  const surname = (body.surname || '').trim();
  const given = (body.given || '').trim();
  if (surname || given) {
    if (!HANGUL.test(surname) || !HANGUL.test(given)) {
      return { error: '이름은 한글로만 입력해 주세요(성·이름 각 5자 이내).' };
    }
  }
  const hanja = (body.hanja || '').trim();
  if (hanja && !HANJA.test(hanja)) return { error: '한자 표기는 한자만 입력해 주세요.' };

  const lon = typeof body.longitude === 'number' ? body.longitude : 126.98;
  if (lon < 124 || lon > 132) return { error: '출생지 경도 범위를 벗어났습니다.' };

  const focus = FOCUS.indexOf(body.focus) >= 0 ? body.focus : '총운';

  return {
    value: {
      calendar: body.calendar, year, month, day, hour, minute,
      leapMonth: !!body.leapMonth, gender: body.gender,
      surname: surname || null, given: given || null, hanja: hanja || null,
      longitude: lon,
      useSolarTime: body.useSolarTime !== false,
      lateNightRule: body.lateNightRule === '자정' ? '자정' : '야자시',
      focus
    }
  };
}

// 모델에게 넘길 계산 결과. 사람이 읽는 문장으로 압축해 둔다.
function describe(r, input) {
  const P = r.pillars;
  const line = (label, p) => p
    ? `${label}: ${p.korean}(${p.hanja})  천간 ${p.stem}=${p.stemElem}(${p.stemYinYang}) / 지지 ${p.branch}=${p.branchElem}, 지장간 ${p.hidden.join('·')}`
    : `${label}: (출생시간 미상 — 시주 없음)`;
  const a = r.analysis;
  const gods = a.tenGods;

  const out = [];
  out.push(`[생년월일] 양력 ${r.solar.year}년 ${r.solar.month}월 ${r.solar.day}일` +
    (input.hour !== null ? ` ${input.hour}시 ${input.minute}분` : ' (시간 미상)') +
    ` / 음력 ${r.lunar.year}년 ${r.lunar.leap ? '윤' : ''}${r.lunar.month}월 ${r.lunar.day}일 / ${input.gender}자`);
  out.push(`[절기] ${r.chart.termName} 중 (태양황경 ${r.chart.solarLongitude}°)` +
    (r.chart.boundaryWarning ? ` — 절입 경계에 가까움: ${r.chart.boundaryWarning}` : ''));
  out.push('[사주팔자]');
  out.push('  ' + line('연주', P.year));
  out.push('  ' + line('월주', P.month));
  out.push('  ' + line('일주', P.day));
  out.push('  ' + line('시주', P.hour));
  out.push(`[일간] ${a.dayMaster.stem}(${a.dayMaster.hanja}) — ${a.dayMaster.elem}, ${a.dayMaster.yang ? '양' : '음'}`);
  out.push(`[십신] 천간 ${gods.stems.map((g) => g.pos + '=' + g.god).join(', ')} / 지지 ${gods.branches.map((g) => g.pos + '=' + g.god).join(', ')}`);
  out.push(`[오행 개수] ${SajuEngine.ELEMS.map((e) => e + ' ' + a.count[e]).join(', ')}` +
    ` (지장간 가중: ${SajuEngine.ELEMS.map((e) => e + ' ' + a.weighted[e]).join(', ')})`);
  out.push(`[없는 오행] ${a.missing.length ? a.missing.join(', ') : '없음'} / [과다] ${a.excess.length ? a.excess.join(', ') : '없음'}`);
  out.push(`[강약] ${a.strength} (일간을 돕는 비율 ${a.strengthRatio}) / 태어난 계절 ${a.season}` +
    (a.johuNeed ? ` — 조후상 ${a.johuNeed} 필요` : ''));
  out.push(`[용신(억부+조후 추정)] ${a.yongsin.join(' > ')}`);
  out.push(`[공망] ${a.gongmang.join('·')} / [신살] ${a.shinsal.length ? a.shinsal.map((s) => s.name + '(' + s.at + ')').join(', ') : '해당 없음'}`);
  out.push(`[대운] ${r.luck.direction}, 대운수 ${r.luck.luckNumber} (${r.luck.startAge}세부터)`);
  out.push('  ' + r.luck.list.map((l) => `${l.ageFrom}~${l.ageTo}세 ${l.hanja}(${l.tenGod})`).join(' / '));
  if (r.currentLuck) {
    out.push(`[현재 대운] ${r.currentLuck.hanja} (${r.currentLuck.ageFrom}~${r.currentLuck.ageTo}세, ${r.currentLuck.tenGod})`);
  }
  out.push(`[올해] ${r.currentYear.year}년 ${r.currentYear.pillar.hanja} / 만 ${r.currentYear.age}세(세는나이 ${r.currentYear.koreanAge}세)`);

  // 좋은 시기·조심할 시기. 화면과 같은 계산을 그대로 넘긴다.
  const age0 = Math.max(0, r.currentYear.age);
  const near = SajuEngine.fortuneTimeline(r, { fromAge: age0, toAge: age0 + 30 });
  const life = r.fortune; // 만 18~90세
  const period = (p) => `${p.fromYear}${p.toYear !== p.fromYear ? '~' + p.toYear : ''}년(만 ${p.fromAge}~${p.toAge}세, 정점 ${p.peakYear} ${p.peakSeun}, ${p.score}점: ${p.reasons.join(' · ')})`;
  out.push('[영역별 시기 — 앞으로 30년]');
  ['money', 'health', 'relation'].forEach((k) => {
    const d = near.domains[k];
    out.push(`  ${d.label} 좋은 시기: ${d.best.map(period).join(' / ')}`);
    out.push(`  ${d.label} 조심할 시기: ${d.worst.map(period).join(' / ')}`);
  });
  out.push('[영역별 시기 — 일생 전체에서 가장 두드러진 한 곳씩]');
  ['money', 'health', 'relation'].forEach((k) => {
    const d = life.domains[k];
    out.push(`  ${d.label}: 최고 ${d.best[0] ? period(d.best[0]) : '-'} / 최저 ${d.worst[0] ? period(d.worst[0]) : '-'}`);
  });
  out.push('  ※ 점수는 이 사람의 일생 안에서의 상대값이다(0~100). 남과 비교하는 값이 아니며,' +
    ' 억부·조후 관점을 수치로 옮긴 해석이지 계산된 사실이 아니다.');

  if (r.name) {
    const n = r.name;
    out.push('[이름]');
    out.push(`  표기: ${n.surname}${n.given}` + (n.hanja ? ` (${n.hanja})` : ' (한자 미입력)'));
    out.push('  글자별: ' + n.syllables.map((s) => `${s.ch}(초성 ${s.cho}=${s.elem}, ${s.strokes}획)`).join(' / '));
    out.push('  발음오행 흐름: ' + n.soundFlow.map((f) => `${f.from}→${f.to} ${f.fromElem}→${f.toElem} ${f.relation}`).join(', ') +
      ` (흐름 ${n.flowScore}점 — 상생은 앞 글자가 뒤 글자를 생하는 것, 역생은 그 반대)`);
    out.push('  수리 사격(한글 획수 기준): ' + n.frames.map((f) => `${f.key} ${f.num}획 ${f.suri.grade}(${f.suri.label}) — ${f.period}`).join(' / '));
    out.push('  ※ 한글 획수는 한자 획수보다 작아 사격이 한 자릿수에 몰린다. 수리 등급은 보조 근거로만 쓰고,' +
      ' 발음오행의 흐름과 용신 보완 여부를 더 무겁게 다룰 것.');
    if (n.sajuMatch) {
      const m = n.sajuMatch;
      out.push(`  용신 보완: 용신 ${m.yongsin.join('>')} 중 ${m.hasPrimary ? '1순위 용신을 이름이 직접 보완함' : m.hasAny ? '보조 용신만 보완함' : '용신 오행이 이름에 없음'}` +
        (m.fillsMissing.length ? ` / 사주에 없던 ${m.fillsMissing.join('·')}를 이름이 채움` : '') +
        (m.addsExcess.length ? ` / 이미 과다한 ${m.addsExcess.join('·')}를 이름이 더함` : ''));
    }
  } else {
    out.push('[이름] 입력되지 않음 — 이름 풀이는 생략하고, 대신 이름에 쓰면 좋을 오행을 한 문단으로 제안할 것');
  }
  return out.join('\n');
}

const SYSTEM = `당신은 한국 명리학(사주)과 성명학을 함께 보는 상담가입니다.
사주 원국·대운·이름 획수와 발음오행은 이미 프로그램이 정확히 계산해 두었습니다.
당신의 일은 그 계산 결과를 사람이 읽을 수 있는 이야기로 풀어내는 것입니다.

지켜야 할 것:
- 주어진 계산 결과만 근거로 씁니다. 간지·십신·획수를 새로 계산하거나 바꾸지 마세요.
  계산에 없는 신살이나 격국을 지어내지 마세요.
- 사주와 이름을 따로 놀게 두지 마세요. 이름의 오행이 사주의 어느 자리를 채우고
  어느 기운을 더 무겁게 하는지, 대운의 흐름과 겹쳐 읽어 주세요. 이것이 이 상담의 핵심입니다.
- 구체적으로 쓰되 단정하지 마세요. "~한 기질이 강하게 나타납니다", "~에서 힘을 얻습니다"처럼
  경향으로 말하고, 정해진 운명처럼 말하지 않습니다.
- 질병 진단, 수명, 사망, 소송·시험의 결과 예측, 특정인과의 궁합 단정은 하지 않습니다.
  건강은 "무리가 가기 쉬운 부위와 생활 습관" 수준으로만 말합니다.
- 개명을 부추기지 마세요. 이름에 아쉬운 점이 있으면 보완하는 생활 방향(색·방위·습관)을
  같이 제시합니다.
- 존중하는 상담 어조의 한국어. 과장된 점술 상투어("천하의 귀격", "만인이 우러러")는 쓰지 않습니다.

- 시기를 말할 때는 주어진 계산 결과에 있는 연도만 씁니다. 없는 해를 지어내지 마세요.
  왜 그 시기인지(어떤 십신이 들어오는지, 용신이 오는지, 어떤 충·합이 걸리는지)를
  한 번은 짚어 주고, 그 시기에 무엇을 하면 좋은지·미루면 좋은지로 이어 주세요.
- '조심할 시기'는 나쁜 일이 정해져 있다는 뜻이 아니라 무리한 확장·과로·성급한 결정을
  피하라는 뜻으로 씁니다. 특히 건강은 진단이 아니라 생활 관리의 관점으로만 다룹니다.

형식(마크다운):
## 한 줄로 요약하면
## 타고난 기질 — 일간과 월지
## 오행의 균형과 지금 필요한 기운
## 이름이 사주에 하는 일
## 대운의 흐름과 지금 자리
## 돈·건강·관계, 언제가 좋고 언제를 조심할까
## 지금 해볼 만한 것
각 절은 3~6문장. '언제가 좋고' 절은 세 영역을 각각 짚어야 하므로 6~9문장까지 씁니다.
전체 1600~2400자. 목록보다 문장으로 씁니다.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'POST 로 요청해 주세요.');
  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(res, 500, '서버에 ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return fail(res, 429, '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return fail(res, 400, '요청 형식이 올바르지 않습니다.'); }
  }
  if (!body || typeof body !== 'object') return fail(res, 400, '요청 본문이 비어 있습니다.');

  const checked = validate(body);
  if (checked.error) return fail(res, 400, checked.error);
  const input = checked.value;

  let reading;
  try {
    reading = SajuEngine.fullReading(input);
  } catch (e) {
    return fail(res, 500, '사주 계산 중 오류가 발생했습니다: ' + e.message);
  }
  if (reading.error) return fail(res, 400, reading.error);

  const userMessage = `아래는 프로그램이 계산한 사주와 이름 정보입니다.

${describe(reading, input)}

이 사람이 특히 궁금해하는 부분: ${input.focus}
위 형식대로 풀이해 주세요. "${input.focus}"에 해당하는 내용은 다른 절보다 한 문단 더 깊게 다뤄 주세요.`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no'); // 프록시가 스트림을 모아두지 않도록

  const client = new Anthropic();
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 12000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: userMessage }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      res.write('\n\n(해석을 이어가지 못했습니다. 입력을 조금 바꿔 다시 시도해 주세요.)');
    }
    res.end();
  } catch (e) {
    const msg = '\n\n[오류] 해석을 생성하지 못했습니다: ' + (e && e.message ? e.message : '알 수 없는 오류');
    if (res.headersSent) { res.write(msg); res.end(); }
    else fail(res, 502, msg.trim());
  }
};
