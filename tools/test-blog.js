#!/usr/bin/env node
// 블로그 글쓰기 도우미 점검. Claude 를 가짜로 세워 두고 api/blog.js 를 그대로 부른다.
//   node tools/test-blog.js
const path = require('path');
const HANDLER = path.resolve(__dirname, '../api/blog.js');
const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [path.resolve(__dirname, '..')] });
let lastParams = null;
class Fake { constructor(){ this.messages = { stream: (p) => { lastParams = p; return {
  async *[Symbol.asyncIterator](){ yield {type:'content_block_delta',delta:{type:'text_delta',text:'본문'}}; },
  finalMessage: async () => ({ stop_reason: 'end_turn' }) }; } }; } }
require.cache[sdkPath] = { id:sdkPath, filename:sdkPath, loaded:true, exports:{ default: Fake } };

process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.BLOG_IP_HOURLY_LIMIT = '4';

const handler = require(HANDLER);
const mkRes = () => { const r={status_:200,body:'',headers:{},headersSent:false};
  r.setHeader=(k,v)=>{r.headers[k]=v;}; r.status=c=>{r.status_=c;return r;};
  r.json=o=>{r.body=JSON.stringify(o);}; r.write=s=>{r.body+=s;r.headersSent=true;}; r.end=()=>{}; return r; };
const call = async (body, ip) => { const res = mkRes();
  await handler({ method:'POST', headers:{'x-forwarded-for': ip||'9.9.9.9'}, body }, res); return res; };

let pass=0, fail=0;
const ok=(l,c,x)=>{ c?pass++:fail++; console.log((c?'  ✓ ':'  ✗ ')+l+(c?'':'  → '+x)); };

const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
(async () => {
  console.log('요청 검증');
  let r = await call({ mode:'draft' });
  ok('사진도 메모도 없으면 400', r.status_ === 400, r.status_);
  r = await call({ mode:'draft', images:[PIC,PIC,PIC,PIC,PIC,PIC,PIC] });
  ok('사진 7장은 400', r.status_ === 400, r.status_);
  r = await call({ mode:'draft', images:['data:image/svg+xml;base64,AAAA'] });
  ok('svg 같은 형식은 400', r.status_ === 400, r.status_);
  r = await call({ mode:'draft', images:['javascript:alert(1)'] });
  ok('data URL 이 아니면 400', r.status_ === 400, r.status_);
  r = await call({ mode:'rewrite', draft:'초안' });
  ok('다시 쓰기에 메모가 없으면 400', r.status_ === 400, r.status_);
  r = await call({ mode:'rewrite', notes:'맛있었다' });
  ok('다시 쓰기에 초안이 없으면 400', r.status_ === 400, r.status_);
  const g = mkRes(); await handler({ method:'GET', headers:{} }, g);
  ok('GET 은 405', g.status_ === 405, g.status_);

  console.log('초안');
  r = await call({ mode:'draft', images:[PIC,PIC], topic:'맛집', keyword:'성수 칼국수', notes:'가격 9000원' });
  ok('정상 요청은 200 이고 글이 흘러나온다', r.status_ === 200 && r.body === '본문', r.status_ + ' ' + r.body);
  const c = lastParams.messages[0].content;
  ok('사진이 image 블록 2개로 넘어간다', c.filter(b => b.type === 'image').length === 2);
  ok('사진 번호 표지가 붙는다', c.some(b => b.text === '[사진2]'));
  ok('메모와 키워드가 프롬프트에 들어간다', JSON.stringify(c).includes('9000원') && JSON.stringify(c).includes('성수 칼국수'));
  ok('초안 시스템 프롬프트를 쓴다', /초안/.test(lastParams.system) && /지어내지/.test(lastParams.system));
  ok('기본 모델은 sonnet-5', lastParams.model === 'claude-sonnet-5', lastParams.model);

  console.log('다시 쓰기');
  r = await call({ mode:'rewrite', draft:'초안 본문', notes:'국물이 짰음', tone:'plain', length:'short' });
  ok('정상 요청은 200', r.status_ === 200, r.status_);
  const t = lastParams.messages[0].content;
  ok('초안과 메모가 둘 다 넘어간다', t.length === 1 && /초안 본문/.test(t[0].text) && /국물이 짰음/.test(t[0].text));
  ok('다시 쓰기에는 사진을 보내지 않는다', !t.some(b => b.type === 'image'));
  ok('의견을 순화하지 말라는 규칙이 있다', /순화하거나/.test(lastParams.system));
  ok('말투·분량이 반영된다', /했다/.test(t[0].text) && /900자/.test(t[0].text));

  console.log('사용량 제한');
  const ip = '7.7.7.7';
  let last;
  for (let i = 0; i < 5; i++) last = await call({ mode:'rewrite', draft:'a', notes:'b' }, ip);
  ok('시간당 한도(4)를 넘기면 429', last.status_ === 429, last.status_);
  ok('Retry-After 가 실린다', !!last.headers['Retry-After']);
  r = await call({ mode:'rewrite', draft:'a', notes:'b' }, '8.8.8.8');
  ok('다른 사람은 영향받지 않는다', r.status_ === 200, r.status_);
  r = await call({ mode:'draft' }, ip);
  ok('검증에서 걸린 요청은 한도를 깎지 않는다(400)', r.status_ === 400, r.status_);

  console.log('키 없음');
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  r = await call({ mode:'rewrite', draft:'a', notes:'b' });
  ok('키가 없으면 503 과 할 일 안내', r.status_ === 503 && /ANTHROPIC_API_KEY/.test(r.body), r.status_);
  process.env.ANTHROPIC_API_KEY = saved;

  console.log('폴더 감시');
  const { groupFiles } = require('./blog-watch.js');
  const M = 60 * 1000;
  const f = (n, min) => ({ path: n, mtime: min * M });
  let gr = groupFiles([f('a', 0), f('b', 5), f('c', 60), f('d', 62)], 20 * M);
  ok('20분 넘게 벌어지면 다른 글로 자른다', gr.length === 2 && gr[0].length === 2 && gr[1].length === 2, JSON.stringify(gr));
  gr = groupFiles([f('b', 5), f('a', 0)], 20 * M);
  ok('시간순으로 정렬한다', gr[0][0].path === 'a');
  gr = groupFiles(Array.from({ length: 8 }, (_, i) => f('p' + i, i)), 20 * M);
  ok('한 글은 6장까지', gr.length === 2 && gr[0].length === 6 && gr[1].length === 2, gr.map((x) => x.length));
  const req = handler.draftRequest({ images: [{ media_type: 'image/jpeg', data: 'AA==' }], topic: '카페' });
  ok('draftRequest 가 사이트와 같은 프롬프트·사진 블록을 만든다',
    req.system.length > 100 && req.messages[0].content.some((b) => b.type === 'image') && /카페/.test(JSON.stringify(req.messages)));

  console.log('\n' + pass + ' 통과, ' + fail + ' 실패');
  process.exit(fail ? 1 : 0);
})();
