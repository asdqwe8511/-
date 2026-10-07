'use strict';
// 일봉에서 피벗 고점/저점을 모아 비슷한 가격끼리 묶고, 많이 닿고 거래량 큰 구간을 가장 강한 선으로 본다.

function pivots(c, k) {
  const out = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (c[j].h > c[i].h) hi = false;
      if (c[j].l < c[i].l) lo = false;
    }
    if (hi) out.push({ price: c[i].h, i, v: c[i].v });
    if (lo) out.push({ price: c[i].l, i, v: c[i].v });
  }
  return out;
}

function cluster(pts, tol, n, avgVol) {
  pts = pts.slice().sort((a, b) => a.price - b.price);
  const groups = [];
  for (const p of pts) {
    const g = groups[groups.length - 1];
    if (g && p.price <= g[0].price * (1 + tol)) g.push(p); else groups.push([p]);
  }
  return groups.map((g) => {
    const price = g.reduce((s, p) => s + p.price, 0) / g.length;
    const recency = g.reduce((s, p) => s + p.i / n, 0);          // 최근 터치일수록 가산
    const vol = g.reduce((s, p) => s + p.v, 0) / (avgVol || 1) / 2;
    return { price, touches: g.length, strength: g.length + recency + vol };
  });
}

// price 아래 가장 강한 지지, 위 가장 강한 저항. 너무 붙거나(minGap) 먼(maxDist) 선은 제외.
function findLevels(candles, price, o) {
  const c = candles.slice(-o.lookback);
  if (c.length < o.pivotWing * 2 + 5) return { support: null, resistance: null };
  const avgVol = c.reduce((s, x) => s + x.v, 0) / c.length;
  const cl = cluster(pivots(c, o.pivotWing), o.clusterTol, c.length, avgVol);
  const best = (arr) => arr.sort((a, b) => b.strength - a.strength)[0] || null;
  const support = best(cl.filter((x) => x.price <= price * (1 - o.minGap) && x.price >= price * (1 - o.maxDist)));
  const resistance = best(cl.filter((x) => x.price >= price * (1 + o.minGap) && x.price <= price * (1 + o.maxDist)));
  return { support, resistance };
}

module.exports = { findLevels, pivots, cluster };
