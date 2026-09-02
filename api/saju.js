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

// ── 사용량 제한 ────────────────────────────────────────────────────────────
//
// 이 엔드포인트는 호출될 때마다 Claude API 요금이 나간다. 사이트가 공개되어
// 있으므로 누구든 반복해서 부를 수 있고, 서버리스는 인스턴스가 여러 개라
// 메모리 카운터로는 막히지 않는다. 그래서 Upstash Redis(REST) 에 공용 카운터를
// 두고 하루 총량과 IP당 시간당 횟수를 함께 센다.
//
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Vercel 통합이 넣어 준다)
//   SAJU_DAILY_LIMIT       하루 총 풀이 횟수 (기본 300)
//   SAJU_IP_HOURLY_LIMIT   한 사람이 한 시간에 부를 수 있는 횟수 (기본 10)
//
// Redis 가 설정되지 않았거나 잠시 응답하지 않으면 통과시킨다(fail-open).
// 사이트가 통째로 멈추는 것보다는 낫고, 마지막 방어선은 Anthropic 콘솔의
// 지출 한도다 — 그쪽은 꼭 걸어 두어야 한다.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DAILY_LIMIT = Number(process.env.SAJU_DAILY_LIMIT || 300);
const IP_HOURLY_LIMIT = Number(process.env.SAJU_IP_HOURLY_LIMIT || 10);

// 인스턴스 안에서만 유효한 1차 브레이크. Redis 가 없을 때의 최소한의 방어다.
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

// 방문자 IP 를 그대로 저장하지 않는다. 세는 데는 해시로 충분하다.
function ipKey(ip) {
  return require('crypto').createHash('sha256')
    .update(ip + '|' + (process.env.SAJU_IP_SALT || 'saju')).digest('hex').slice(0, 16);
}

async function redisPipeline(commands) {
  const res = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('redis ' + res.status);
  return res.json();
}

/**
 * 하루 총량과 IP당 시간당 횟수를 함께 올리고 확인한다.
 * @returns {{ok: boolean, reason?: string, retryAfter?: number}}
 */
async function checkQuota(ip) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return locallyRateLimited(ip)
      ? { ok: false, reason: 'ip', retryAfter: 600 }
      : { ok: true, unmetered: true };
  }
  const now = new Date();
  const day = now.toISOString().slice(0, 10);          // YYYY-MM-DD (UTC)
  const hour = now.toISOString().slice(0, 13);         // YYYY-MM-DDTHH
  const dayKey = 'saju:day:' + day;
  const hourKey = 'saju:ip:' + hour + ':' + ipKey(ip);
  try {
    const out = await redisPipeline([
      ['INCR', dayKey], ['EXPIRE', dayKey, 172800],
      ['INCR', hourKey], ['EXPIRE', hourKey, 7200]
    ]);
    const dayCount = Number(out[0] && out[0].result);
    const ipCount = Number(out[2] && out[2].result);
    if (Number.isFinite(ipCount) && ipCount > IP_HOURLY_LIMIT) {
      return { ok: false, reason: 'ip', retryAfter: 600 };
    }
    if (Number.isFinite(dayCount) && dayCount > DAILY_LIMIT) {
      return { ok: false, reason: 'day', retryAfter: 3600 };
    }
    return { ok: true, dayCount, ipCount };
  } catch (e) {
    // 카운터가 죽었다고 사이트를 멈추지는 않는다.
    console.error('[quota] Redis 확인 실패, 통과시킴:', e.message);
    return { ok: true, degraded: true };
  }
}

const HANGUL = /^[가-힣]{1,5}$/;
const HANJA = /^[㐀-䶿一-鿿]{1,5}$/;
const FOCUS = ['총운', '성격', '직업·적성', '재물', '건강', '인간관계'];

function fail(res, code, message) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).json({ error: { message } });
}

// 나와 상대를 같은 규칙으로 검사한다. 이름 칸은 한글만 통과하므로,
// 자유 문장이 프롬프트에 닿는 경로가 여기에도 없다.
function validatePerson(body, who) {
  const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  const year = int(body.year), month = int(body.month), day = int(body.day);
  if (year === null || year < 1900 || year > 2100) return { error: who + '의 생년은 1900~2100년만 계산합니다.' };
  if (month === null || month < 1 || month > 12) return { error: who + '의 월이 올바르지 않습니다.' };
  if (day === null || day < 1 || day > 31) return { error: who + '의 일이 올바르지 않습니다.' };

  const hasHour = body.hour !== null && body.hour !== undefined;
  const hour = hasHour ? int(body.hour) : null;
  const minute = hasHour ? (int(body.minute) === null ? 0 : int(body.minute)) : null;
  if (hasHour && (hour === null || hour < 0 || hour > 23)) return { error: who + '의 시가 올바르지 않습니다.' };
  if (hasHour && (minute < 0 || minute > 59)) return { error: who + '의 분이 올바르지 않습니다.' };

  if (body.gender !== '남' && body.gender !== '여') return { error: who + '의 성별을 선택해 주세요.' };
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

  return {
    value: {
      calendar: body.calendar, year, month, day, hour, minute,
      leapMonth: !!body.leapMonth, gender: body.gender,
      surname: surname || null, given: given || null, hanja: hanja || null,
      longitude: lon,
      useSolarTime: body.useSolarTime !== false,
      lateNightRule: body.lateNightRule === '자정' ? '자정' : '야자시'
    }
  };
}

function validate(body) {
  const me = validatePerson(body, '나');
  if (me.error) return me;
  me.value.focus = FOCUS.indexOf(body.focus) >= 0 ? body.focus : '총운';
  me.value.mode = body.mode === 'compat' ? 'compat' : 'solo';

  if (me.value.mode === 'compat') {
    if (!body.partner || typeof body.partner !== 'object') {
      return { error: '상대방 정보가 없습니다.' };
    }
    const other = validatePerson(body.partner, '상대');
    if (other.error) return { error: '상대: ' + other.error };
    me.value.partner = other.value;
  }
  return me;
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
    ' 억부·조후 관점을 수치로 옮긴 해석이지 계산된 사실이 아니다.' +
    ' 이 숫자는 판단 재료일 뿐이니 답변 문장에는 절대 쓰지 말고 말로 옮길 것.');

  // 올해 열두 달, 아홉 영역. 화면이 보여 주는 것과 같은 계산이다.
  try {
    const ym = SajuEngine.yearMonths(r, r.currentYear.year);
    out.push(`[올해(${ym.year}) 달별 — 아홉 영역, 절기 기준]`);
    SajuEngine.DOMAIN9.forEach((k) => {
      const d = ym.domains[k];
      out.push(`  ${d.label}: 가장 좋은 달 ${d.best.label} (${d.best.ganji.hanja}) /` +
        ` 가장 조심할 달 ${d.worst.label} (${d.worst.ganji.hanja})`);
    });
    const today = SajuEngine.dailyFortune(r);
    if (today && !today.error) {
      out.push(`[오늘(${today.date.month}월 ${today.date.day}일)] 일진 ${today.ganji.hanja}` +
        ` — 일간 기준 천간 ${today.tenGod.stem}, 지지 ${today.tenGod.branch}` +
        (today.gongmang ? ' (공망일)' : '') +
        ` / 오늘 두드러지는 영역: ${today.best.map((x) => x.label).join('·')},` +
        ` 눌리는 영역: ${today.worst.map((x) => x.label).join('·')}`);
    }
  } catch (e) { /* 달별 계산이 실패해도 나머지 풀이는 그대로 나가야 한다 */ }

  out.push(`[띠·별자리] 띠 ${r.animal} / 별자리 ${r.zodiac.name}(${r.zodiac.elem})` +
    ' ※ 별자리는 사주와 다른 체계다. 묻지 않으면 굳이 끌어들이지 말고,' +
    ' 언급하더라도 사주 판단의 근거로 삼지 말 것.');

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

// 궁합 모드에서 모델에게 넘길 내용. 두 사람의 원국을 각각 짧게 적고,
// 계산된 축 점수와 항목을 그대로 붙인다. 점수만 주면 모델이 이유를 지어낸다.
function describeCompat(A, B, c, inputA, inputB) {
  const brief = (label, r, input) => {
    const p = r.pillars;
    const four = ['year', 'month', 'day', 'hour']
      .map((k) => p[k] ? p[k].korean + '(' + p[k].hanja + ')' : '시주 없음').join(' ');
    return [
      `[${label}] 양력 ${r.solar.year}.${r.solar.month}.${r.solar.day}` +
        (input.hour !== null ? ` ${input.hour}시` : ' (시각 미상)') + ` / ${input.gender}자` +
        (r.name ? ` / 이름 ${r.name.surname}${r.name.given}` : ''),
      `  사주: ${four}`,
      `  일간 ${r.analysis.dayMaster.stem}(${r.analysis.dayMaster.elem}, ${r.analysis.dayMaster.yang ? '양' : '음'})` +
        ` / ${r.analysis.strength} / 용신 ${r.analysis.yongsin.join('>')} / ${r.analysis.season}생`,
      `  오행: ${SajuEngine.ELEMS.map((e) => e + ' ' + r.analysis.count[e]).join(', ')}` +
        (r.analysis.missing.length ? ` (없는 오행 ${r.analysis.missing.join('·')})` : ''),
      `  십신: 천간 ${r.analysis.tenGods.stems.map((g) => g.pos + '=' + g.god).join(', ')}`,
      `  신살: ${r.analysis.shinsal.length ? r.analysis.shinsal.map((s) => s.name).join(', ') : '해당 없음'}`
    ].join('\n');
  };

  const out = [];
  out.push(brief('나', A, inputA));
  out.push(brief('상대', B, inputB));
  out.push('');
  out.push(`[궁합 점수] ${c.total} (원점수 ${c.raw}) — 무작위로 짝지은 48,180쌍 분포에 견준 백분위다.` +
    ' 50이 평범, 80이면 상위 20%. 100점 만점의 점수가 아니다.');
  out.push('[축별 점수] ' + SajuEngine.COMPAT_AXES.map((k) => `${c.axes[k].label} ${c.axes[k].score}`).join(' / '));
  SajuEngine.COMPAT_AXES.forEach((k) => {
    const ax = c.axes[k];
    if (!ax.items.length) return;
    out.push(`  ${ax.label}: ` + ax.items.map((i) => `${i.label}(${i.delta > 0 ? '+' : ''}${i.delta})`).join(' / '));
  });
  const d = c.detail;
  out.push(`[관계 요약] 일간 ${d.dayStems.join('·')} ${d.dayStemRelation}` +
    ` / 일지 ${d.dayBranchRelations.length ? d.dayBranchRelations.join('·') : '무관'}` +
    ` / 띠 ${d.zodiac.join('·')} ${d.zodiacRelations.length ? d.zodiacRelations.join('·') : '무관'}`);
  out.push(`  상대는 나에게 ${d.godBtoA}, 나는 상대에게 ${d.godAtoB}`);
  out.push(`  힘의 세기 ${d.strength.join(' / ')} · 계절 ${d.season.join(' / ')} · 용신 ${d.yongsin.join(' / ')}`);
  if (d.name) out.push(`  이름 소리: 내 끝 글자와 상대 첫 글자가 ${d.name.tailHeadRelation}` +
    ` (내 이름 오행 ${d.name.aElems.join('·')} / 상대 ${d.name.bElems.join('·')})`);
  out.push('  ※ 축 점수와 항목 값은 억부 관점을 수치로 옮긴 해석이지 계산된 사실이 아니다.' +
    ' 이 숫자는 판단 재료일 뿐이니 답변 문장에는 절대 쓰지 말고 말로 옮길 것.');

  // 관계별로 나눠 본 궁합. 같은 두 사람이라도 애인으로 볼 때와 같이 일할 때
  // 중요한 축이 다르므로, 네 가지를 따로 넘긴다.
  try {
    const rel = SajuEngine.relationCompat(A, B, c);
    out.push('[관계별 궁합] 네 축을 관계마다 다르게 저울질한 결과(백분위)');
    SajuEngine.REL_TYPES.forEach((t) => {
      const x = rel.types[t];
      out.push(`  ${x.label}: ${x.score} — ${x.grade} / 받쳐 주는 축 순서 ` +
        x.axisOrder.map((k) => c.axes[k].label).join(' > '));
    });
    if (rel.talk) {
      out.push(`  상대가 나에게 ${rel.godBtoA} 이므로 —` +
        ` 하면 좋은 말: ${rel.talk.good} / 피할 말: ${rel.talk.bad}`);
    }
    if (rel.act) {
      out.push(`  일지가 ${rel.actRelation} 이므로 —` +
        ` 하면 좋은 행동: ${rel.act.good} / 피할 행동: ${rel.act.bad}`);
    }
    out.push('  ※ 위 문장은 화면에 이미 그대로 나가 있다. 되풀이하지 말고,' +
      ' 왜 그런지를 두 사람의 사주로 풀어 주거나 이 사람들에 맞게 구체적으로 바꿔 쓸 것.');
  } catch (e) { /* 관계별 계산이 실패해도 나머지 풀이는 그대로 나가야 한다 */ }

  return out.join('\n');
}

const SYSTEM_COMPAT = `당신은 한국 명리학으로 두 사람의 궁합을 보는 상담가입니다.
두 사람의 원국과 궁합 점수는 이미 프로그램이 계산해 두었습니다. 당신의 일은 그 결과를
사람이 읽을 수 있는 이야기로 풀어내는 것입니다.

지켜야 할 것:
- 주어진 계산 결과만 근거로 씁니다. 간지·십신·점수를 새로 만들지 마세요.
- **숫자 점수를 문장에 쓰지 마세요.** 주어진 0~100 값은 어느 축이 더 받쳐 주는지 판단하는
  데만 쓰고, 글에서는 "잘 맞는 편", "무난한 편", "맞춰가야 하는 편"처럼 말로 옮깁니다.
  "궁합 73점" 같은 표현은 쓰지 않습니다. 사람 사이를 점수로 매기는 인상을 주기 때문입니다.
- 점수가 낮다고 "만나지 마라", 높다고 "천생연분"이라고 하지 마세요. 궁합은 정해진 결과가
  아니라 서로 다른 두 기질이 어디서 맞물리고 어디서 어긋나는지를 보는 것입니다.
  낮은 점수는 "더 많은 대화와 조율이 필요한 조합"으로 씁니다.
- 상대를 깎아내리지 마세요. 마찰 지점은 사람의 흠이 아니라 두 기질이 만나는 방식으로 씁니다.
- 결혼·이별·임신·재산 분할 같은 결정을 지시하지 마세요. 판단은 두 사람의 몫입니다.
- 계산에 없는 궁합 요소(겉궁합·속궁합 같은 표현 포함)를 지어내지 마세요.
- 존중하는 상담 어조의 한국어. 과장된 점술 상투어는 쓰지 않습니다.

형식(마크다운):
## 한 줄로 요약하면
## 두 사람은 각각 어떤 사람인가
## 무엇이 서로를 당기는가
## 어디서 부딪히기 쉬운가
## 이 관계를 오래 가져가려면
각 절은 3~6문장. '오래 가져가려면'은 계산된 마찰 지점 하나하나에 대해
구체적으로 무엇을 조심하고 무엇으로 메울 수 있는지 적어 5~8문장까지 씁니다.
이름이 둘 다 주어졌다면 이름의 소리가 어떻게 작용하는지도 한 문단 넣습니다.
전체 1400~2000자. 목록보다 문장으로 씁니다.`;

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

- **숫자 점수를 문장에 쓰지 마세요.** 주어진 자료의 0~100 값은 어느 쪽이 더 두드러지는지
  판단하는 데만 쓰고, 글에서는 "힘이 실리는 편", "무난한 편", "조금 눌리는 편"처럼 말로 옮깁니다.
  "재물운 87점" 같은 표현은 쓰지 않습니다. 사람의 삶을 점수로 매기는 인상을 주기 때문입니다.
- 건강은 병이 아니라 생활 리듬의 이야기로 씁니다. 진단·질병명·수명은 언급하지 않습니다.
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return fail(res, 400, '요청 형식이 올바르지 않습니다.'); }
  }
  if (!body || typeof body !== 'object') return fail(res, 400, '요청 본문이 비어 있습니다.');

  const checked = validate(body);
  if (checked.error) return fail(res, 400, checked.error);
  const input = checked.value;

  // 형식이 틀린 요청이 하루 분량을 깎지 않도록, 검증을 통과한 뒤에 센다.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const quota = await checkQuota(ip);
  if (!quota.ok) {
    res.setHeader('Retry-After', String(quota.retryAfter || 600));
    return fail(res, 429, quota.reason === 'day'
      ? '오늘 준비된 풀이 분량이 모두 나갔습니다. 내일 다시 찾아와 주세요. ' +
        '사주표·오행·대운·시기·이름·궁합 계산은 지금도 그대로 보실 수 있습니다.'
      : '조금 빠르게 여러 번 요청하셨습니다. 10분쯤 뒤에 다시 시도해 주세요. ' +
        '아래 계산 결과는 그대로 보실 수 있습니다.');
  }

  let reading, partnerReading = null, compat = null;
  try {
    reading = SajuEngine.fullReading(input);
    if (input.mode === 'compat') {
      partnerReading = SajuEngine.fullReading(input.partner);
      if (partnerReading.error) return fail(res, 400, '상대: ' + partnerReading.error);
      compat = SajuEngine.compatibility(reading, partnerReading);
    }
  } catch (e) {
    return fail(res, 500, '사주 계산 중 오류가 발생했습니다: ' + e.message);
  }
  if (reading.error) return fail(res, 400, reading.error);

  const system = input.mode === 'compat' ? SYSTEM_COMPAT : SYSTEM;
  const userMessage = input.mode === 'compat'
    ? `아래는 프로그램이 계산한 두 사람의 사주와 궁합입니다.

${describeCompat(reading, partnerReading, compat, input, input.partner)}

위 형식대로 궁합을 풀이해 주세요.`
    : `아래는 프로그램이 계산한 사주와 이름 정보입니다.

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
      system: system,
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
