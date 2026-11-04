#!/usr/bin/env node
// wholesale.html 의 계산 구간(@core-start ~ @core-end)만 잘라 검증한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'wholesale.html'), 'utf8');
const m = /\/\/ @core-start([\s\S]*?)\/\/ @core-end/.exec(html);
assert(m, '계산 구간 표시를 찾지 못했습니다');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1], ctx);

// ISBN-10 → 13, 하이픈 제거
assert.strictEqual(ctx.normIsbn('12345'), '');                   // 잘못된 길이
assert.strictEqual(ctx.normIsbn('978-89-364-3412-0'), '9788936434120');
assert.strictEqual(ctx.normIsbn('0306406152'), '9780306406157');

// 출고율 표기
assert.strictEqual(ctx.normRate('65%'), 65);
assert.strictEqual(ctx.normRate('0.65'), 65);
assert.strictEqual(ctx.normRate('abc'), null);

// 거래처 파일: 따옴표·BOM·재고 열
const f = ctx.parseSupplierFile('﻿ISBN,"출고율(%)",현재고\n9788936434120,"67",50\n9791190090018,65,2\n');
assert.strictEqual(f.n, 2);
assert.strictEqual(f.map['9791190090018'].stock, 2);
assert(ctx.parseSupplierFile('a,b\n1,2').error);

// 주문: 제목 줄 건너뜀, 같은 ISBN 합산
const p = ctx.parseOrders('ISBN,수량\n9788936434120,2\n9788936434120,3\nxx,1\n');
assert.strictEqual(p.orders.length, 1);
assert.strictEqual(p.orders[0].qty, 5);
assert.strictEqual(p.bad.length, 1);

// 비교: 최저 선택, 재고 부족 제외, 동률은 앞 거래처
const data = {
  '북센': ctx.parseSupplierFile('ISBN,출고율,재고\n9788936434120,67,50\n9791190090018,65,2\n9788954655972,66,9').map,
  '교보': ctx.parseSupplierFile('ISBN,출고율,재고\n9788936434120,64,20\n9791190090018,60,1\n9788954655972,66,9').map,
};
const r = ctx.compare(
  [{ isbn: '9788936434120', qty: 5 }, { isbn: '9791190090018', qty: 3 }, { isbn: '9788954655972', qty: 1 }, { isbn: '9780000000002', qty: 1 }],
  data, { mode: 'low', useStock: true });
assert.strictEqual(r[0].best, '교보');
assert.strictEqual(r[1].best, null);                       // 둘 다 재고 부족
assert.strictEqual(r[2].best, '북센');                     // 동률
assert.strictEqual(r[3].best, null);                       // 미취급
const hi = ctx.compare([{ isbn: '9788936434120', qty: 1 }], data, { mode: 'high', useStock: false });
assert.strictEqual(hi[0].best, '북센');
assert.strictEqual(Object.keys(ctx.groupBySupplier(r)).sort().join(), '교보,북센');
console.log('wholesale: ok');
