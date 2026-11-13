"""합성 시장 데이터. 15m 봉만 만들고 1h/4h 는 거기서 집계해 시간봉 간 일관성을 보장한다."""
from __future__ import annotations

import math

from fibo_alert.config import load_config
from fibo_alert.store import Store

M15, H1, H4 = 900_000, 3_600_000, 14_400_000
T0 = 1_700_000_000_000 // H4 * H4
K = 40_000.0  # 롱 시나리오: 가격 거울 기준


def cfg_for_tests(**over):
    base = {"trend": {"max_extension_pct": {"15m": 8.0, "1h": 12.0, "4h": 20.0}},
            "history_bars": {"15m": 900, "1h": 500, "4h": 120}}
    for k, v in over.items():
        base.setdefault(k, {}).update(v)
    return load_config(None, base)


def background(n=3600, p0=32000.0, p1=19000.0):
    bars, prev = [], p0
    for i in range(n):
        c = p0 + (p1 - p0) * (i + 1) / n + 12 * math.sin(i / 3.0) + 7 * math.sin(i / 1.7)
        o = prev
        bars.append((o, max(o, c) + 6, min(o, c) - 6, c))
        prev = c
    return bars


def bar(o, c, hi=None, lo=None):
    return (o, hi if hi is not None else max(o, c) + 3, lo if lo is not None else min(o, c) - 3, c)


def ramp(frm, to, n, wick=3):
    out, p = [], frm
    for i in range(n):
        c = frm + (to - frm) * (i + 1) / n
        out.append(bar(p, c, max(p, c) + wick, min(p, c) - wick))
        p = c
    return out


def mirror(bars, k=K):
    return [(k - o, k - l, k - h, k - c) for o, h, l, c in bars]


def build_store(bars15, path=":memory:", source="live", symbol="BTCUSDT") -> Store:
    st = Store(path, symbol, source)
    rows = [(T0 + i * M15, o, h, l, c, 1.0) for i, (o, h, l, c) in enumerate(bars15)]
    st.upsert_candles("15m", rows)
    for tf, m in (("1h", H1), ("4h", H4)):
        k = m // M15
        agg = []
        for g in range(len(rows) // k):
            chunk = rows[g * k:(g + 1) * k]
            if chunk[0][0] % m:
                continue
            agg.append((chunk[0][0], chunk[0][1], max(r[2] for r in chunk), min(r[3] for r in chunk),
                        chunk[-1][4], sum(r[5] for r in chunk)))
        st.upsert_candles(tf, agg)
    return st


def close_of(i):  # i 번째 15m 봉의 종료시각
    return T0 + (i + 1) * M15


def fake_fit(A_v, Z_v, start_time, n=3):
    """auto_find 대체: 숏 세계 좌표의 동결 피팅 dict."""
    return {"target": Z_v, "zone_lo": Z_v - 3, "zone_hi": Z_v + 3, "n_matches": n, "mean_err": 1.0,
            "mean_err_atr": 0.05, "zone_width": 6.0, "score": 4.0,
            "matches": [{"time": start_time + j, "price": A_v - 100 * (j + 1), "ratio": 0.5, "z": Z_v}
                        for j in range(n)],
            "start_time": start_time, "start_price": A_v, "min_low": Z_v + 300, "atr": 20.0,
            "pivots": [[start_time + 10, A_v - 300]], "ratios": [0.236, 0.382, 0.5, 0.618, 0.786]}
