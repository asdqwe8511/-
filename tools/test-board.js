#!/usr/bin/env node
// 불편 게시판 점검: 글쓰기·검증·공감 중복 방지·사용량 제한·관리자 삭제.
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.BOARD_ADMIN_KEY = 'secret-admin'; process.env.BOARD_IP_HOURLY_LIMIT = '5';
const assert = require('assert');
const handler = require('../api/board.js');

function call(method, { body, query, headers } = {}) {
  return new Promise((resolve) => {
    const res = { code: 200, h: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.h[k] = v; },
      json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method, body, query, headers: headers || { 'x-forwarded-for': '1.1.1.1' } }, res);
  });
}
let n = 0; const ok = (name) => { n++; console.log('  ok  ' + name); };

(async () => {
  let r = await call('POST', { body: { text: '   ' } }); assert.strictEqual(r.code, 400); ok('빈 글 거절');
  r = await call('POST', { body: { text: 'a'.repeat(141) } }); assert.strictEqual(r.code, 400); ok('140자 초과 거절');
  r = await call('POST', { body: { text: '<img src=x onerror=alert(1)>‮', color: 'pink' } });
  assert.strictEqual(r.code, 201); assert.ok(!r.body.note.text.includes('‮')); ok('글 등록, 제어문자 제거');
  const id = r.body.note.id;
  r = await call('POST', { body: { text: 'x', color: 'evil' } }); assert.ok(['yellow','pink','blue','green'].includes(r.body.note.color)); ok('엉뚱한 색은 기본색으로');
  r = await call('GET'); assert.strictEqual(r.body.notes.length, 2); assert.strictEqual(r.body.notes[0].agree, 0);
  assert.ok(!('ip' in r.body.notes[0])); ok('목록 조회, 글쓴이 정보 없음');
  r = await call('POST', { body: { action: 'agree', id } }); assert.strictEqual(r.body.added, true);
  r = await call('POST', { body: { action: 'agree', id } }); assert.strictEqual(r.body.added, false); ok('같은 사람 공감 중복 방지');
  r = await call('POST', { body: { action: 'agree', id }, headers: { 'x-forwarded-for': '2.2.2.2' } }); assert.strictEqual(r.body.added, true);
  r = await call('GET'); assert.strictEqual(r.body.notes.find((x) => x.id === id).agree, 2); ok('공감 집계');
  r = await call('DELETE', { query: { id }, headers: { 'x-admin-key': 'nope' } }); assert.strictEqual(r.code, 403); ok('키 없이 삭제 거절');
  r = await call('DELETE', { query: { id }, headers: { 'x-admin-key': 'secret-admin' } }); assert.strictEqual(r.code, 200);
  r = await call('GET'); assert.strictEqual(r.body.notes.length, 1); ok('관리자 삭제');
  let last; for (let i = 0; i < 6; i++) last = await call('POST', { body: { text: 'spam' + i } });
  assert.strictEqual(last.code, 429); ok('시간당 횟수 제한');
  console.log('\n' + n + '가지 통과');
})().catch((e) => { console.error(e); process.exit(1); });
