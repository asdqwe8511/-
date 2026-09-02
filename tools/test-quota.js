#!/usr/bin/env node
// 사용량 제한 점검. Redis 와 Claude 를 가짜로 세워 두고 api/saju.js 를 그대로 부른다.
//   node tools/test-quota.js
const path = require('path');
const HANDLER = path.resolve(__dirname, '../api/saju.js');
const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [path.resolve(__dirname, '..')] });
class Fake { constructor(){ this.messages = { stream: () => ({
  async *[Symbol.asyncIterator](){ yield {type:'content_block_delta',delta:{type:'text_delta',text:'ok'}}; },
  finalMessage: async () => ({ stop_reason: 'end_turn' }) }) }; } }
require.cache[sdkPath] = { id:sdkPath, filename:sdkPath, loaded:true, exports:{ default: Fake } };

process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
process.env.SAJU_DAILY_LIMIT = '5';
process.env.SAJU_IP_HOURLY_LIMIT = '3';

let dayCount = 0, ipCount = 0, redisMode = 'ok', lastBody = null;
global.fetch = async (url, opts) => {
  if (String(url).includes('upstash')) {
    lastBody = JSON.parse(opts.body);
    if (redisMode === 'error') return { ok:false, status:500, json: async()=>({}) };
    if (redisMode === 'throw') throw new Error('네트워크 끊김');
    dayCount++; ipCount++;
    return { ok:true, status:200, json: async () => [
      { result: dayCount }, { result: 1 }, { result: ipCount }, { result: 1 }] };
  }
  throw new Error('예상치 못한 fetch: ' + url);
};

const handler = require(HANDLER);
const mkRes = () => { const r={status_:200,body:'',headers:{},headersSent:false};
  r.setHeader=(k,v)=>{r.headers[k]=v;}; r.status=c=>{r.status_=c;return r;};
  r.json=o=>{r.body=JSON.stringify(o);}; r.write=s=>{r.body+=s;r.headersSent=true;}; r.end=()=>{}; return r; };
const me = { calendar:'양력', year:1990, month:5, day:15, hour:14, minute:30, gender:'남' };
const call = async (body, ip) => { const res = mkRes();
  await handler({ method:'POST', headers:{'x-forwarded-for': ip||'1.1.1.1'}, body }, res); return res; };

let pass=0, fail=0;
const ok=(l,c,x)=>{ c?pass++:fail++; console.log((c?'  ✓ ':'  ✗ ')+l+(c?'':'  → '+x)); };

(async () => {
  console.log('IP 시간당 상한 3, 하루 상한 5');
  for (let i=1;i<=3;i++) { const r=await call(me); ok(`${i}번째 통과`, r.status_===200, r.status_+' '+r.body.slice(0,60)); }
  const r4 = await call(me);
  ok('4번째는 IP 제한', r4.status_===429 && /10분쯤 뒤/.test(r4.body), r4.status_+' '+r4.body);
  ok('Retry-After 헤더', r4.headers['Retry-After']==='600', r4.headers['Retry-After']);

  console.log('\n다른 IP 로 계속 → 하루 상한에 걸림');
  ipCount = 0;
  const r5 = await call(me,'2.2.2.2'); ok('5번째(일 5) 통과', r5.status_===200, r5.status_);
  ipCount = 0;
  const r6 = await call(me,'3.3.3.3');
  ok('6번째는 하루 상한', r6.status_===429 && /오늘 준비된 풀이 분량/.test(r6.body), r6.status_+' '+r6.body.slice(0,80));

  console.log('\n형식이 틀린 요청은 분량을 깎지 않는가');
  const before = dayCount;
  const bad = await call({ ...me, year:1800 });
  ok('400 으로 거절', bad.status_===400, bad.status_);
  ok('카운터 그대로', dayCount===before, `${before} → ${dayCount}`);

  console.log('\nRedis 가 죽었을 때는 통과(fail-open)');
  redisMode='throw';
  const rd = await call(me,'4.4.4.4'); ok('통과함', rd.status_===200, rd.status_+' '+rd.body.slice(0,60));
  redisMode='error';
  const rd2 = await call(me,'5.5.5.5'); ok('HTTP 오류일 때도 통과', rd2.status_===200, rd2.status_);

  console.log('\nRedis 명령 형태');
  redisMode='ok'; ipCount=0; dayCount=0;
  await call(me,'6.6.6.6');
  ok('INCR/EXPIRE 4개', lastBody.length===4, JSON.stringify(lastBody));
  ok('IP 를 그대로 저장하지 않음', !JSON.stringify(lastBody).includes('6.6.6.6'), JSON.stringify(lastBody[2]));
  ok('일 카운터 키에 날짜', /^saju:day:\d{4}-\d{2}-\d{2}$/.test(lastBody[0][1]), lastBody[0][1]);

  console.log('\nRedis 미설정이면 메모리 제한으로 동작');
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete require.cache[require.resolve(HANDLER)];
  const h2 = require(HANDLER);
  const call2 = async (ip) => { const res=mkRes(); await h2({method:'POST',headers:{'x-forwarded-for':ip},body:me},res); return res; };
  let last;
  for (let i=0;i<4;i++) last = await call2('7.7.7.7');
  ok('4번째에서 메모리 제한 걸림', last.status_===429, last.status_+' '+last.body.slice(0,50));

  console.log('\n키가 없을 때 할 일을 알려 주는가');
  // "환경변수가 설정되지 않았습니다" 만으로는 무엇을 해야 할지 알 수 없다.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete require.cache[require.resolve(HANDLER)];
  const noKeyH = require(HANDLER);
  const noKeyRes = mkRes();
  await noKeyH({ method:'POST', headers:{'x-forwarded-for':'10.10.10.10'}, body: me }, noKeyRes);
  ok('503 으로 답한다(고장 아님)', noKeyRes.status_ === 503, noKeyRes.status_);
  ok('어디에 넣는지 알려 준다', /Environment Variables/.test(noKeyRes.body), noKeyRes.body.slice(0, 80));
  ok('어디서 발급하는지 알려 준다', /console\.anthropic\.com/.test(noKeyRes.body), true);
  ok('계산은 그대로 된다고 알려 준다', /계산은 지금도 그대로/.test(noKeyRes.body), true);
  process.env.ANTHROPIC_API_KEY = savedKey;

  console.log('\n오래 걸리는 풀이는 스스로 멈추는가');
  // 플랫폼이 끊기 전에 우리가 먼저 멈춰야 한다. 그냥 두면 문장 한가운데서
  // 연결이 끊겨, 읽는 사람은 글이 원래 그렇게 끝난 줄 안다.
  let aborted = false;
  class Slow { constructor(){ this.messages = { stream: () => ({
    abort(){ aborted = true; },
    async *[Symbol.asyncIterator](){
      for (let i=0;i<40;i++){
        await new Promise(r=>setTimeout(r,60));
        yield {type:'content_block_delta',delta:{type:'text_delta',text:'가나다라마'}};
      }
    },
    finalMessage: async () => ({ stop_reason:'end_turn' }) }) }; } }
  require.cache[sdkPath].exports = { default: Slow };
  process.env.SAJU_MAX_SECONDS = '5';   // 예산 5초 − 여유 4초 = 1초 뒤 멈춤
  delete require.cache[require.resolve(HANDLER)];
  const slowH = require(HANDLER);
  const slowRes = mkRes();
  const slowT0 = Date.now();
  await slowH({method:'POST',headers:{'x-forwarded-for':'8.8.8.8'},body:me}, slowRes);
  const took = Date.now() - slowT0;
  ok('1~3초 안에 끝남', took >= 800 && took < 3000, took+'ms');
  ok('스트림을 끊었다', aborted, aborted);
  ok('200 으로 정상 종료', slowRes.status_===200, slowRes.status_);
  ok('여기서 멈췄다고 알림', /여기서 멈췄습니다/.test(slowRes.body), slowRes.body.slice(-80));
  ok('그때까지 쓴 글은 남는다', slowRes.body.includes('가나다라마'), slowRes.body.slice(0,30));

  console.log('\n짧은 풀이는 안내가 붙지 않는가');
  class Quick { constructor(){ this.messages = { stream: () => ({
    abort(){},
    async *[Symbol.asyncIterator](){ yield {type:'content_block_delta',delta:{type:'text_delta',text:'짧은 풀이'}}; },
    finalMessage: async () => ({ stop_reason:'end_turn' }) }) }; } }
  require.cache[sdkPath].exports = { default: Quick };
  delete require.cache[require.resolve(HANDLER)];
  const quickH = require(HANDLER);
  const quickRes = mkRes();
  await quickH({method:'POST',headers:{'x-forwarded-for':'9.9.9.9'},body:me}, quickRes);
  ok('안내 없음', !/여기서 멈췄습니다/.test(quickRes.body), quickRes.body.slice(0,40));

  console.log(`\n${pass} 통과, ${fail} 실패`);
  process.exit(fail?1:0);
})();
