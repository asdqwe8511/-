import numpy as np
import pandas as pd
import pytest

from fibo_alert import fib, indicators as ind, trend
from fibo_alert.store import Store
from fibo_alert.util import DataError
import synth


def test_pivot_needs_right_confirmation():
    h = np.array([1, 2, 3, 4, 5, 9, 5, 4, 3, 2, 1, 0.5], dtype=float)
    assert list(ind.pivot_high_pos(h, 5)) == [5]
    # 오른쪽 봉이 4개뿐이면(미확정) 피벗이 아니다
    assert list(ind.pivot_high_pos(h[:10], 5)) == []
    # 동일 고점은 처음 것만
    h2 = np.array([1, 2, 3, 4, 5, 9, 9, 4, 3, 2, 1, 0.5], dtype=float)
    assert list(ind.pivot_high_pos(h2, 5)) == [5]


def test_atr_mirror_invariant():
    df = pd.DataFrame(synth.background(400), columns=["open", "high", "low", "close"])
    m = pd.DataFrame(synth.mirror(synth.background(400)), columns=["open", "high", "low", "close"])
    assert np.allclose(ind.atr(df).values, ind.atr(m).values)


def test_reverse_formula():
    A, Z = 20000.0, 19000.0
    for r in (0.236, 0.382, 0.5, 0.618, 0.786):
        p = fib.level_price(Z, A, r)
        assert fib.reverse_zero(p, A, r) == pytest.approx(Z)


def test_find_fit_needs_three_independent_pivots():
    A, Z, atr = 20000.0, 19000.0, 12.0
    piv = [(i, fib.level_price(Z, A, r)) for i, r in enumerate((0.382, 0.5, 0.618))]
    f = fib.find_fit(A, piv, 19100.0, atr, [0.236, 0.382, 0.5, 0.618, 0.786], 0.5, 3)
    assert f and f["n_matches"] == 3 and f["target"] == pytest.approx(Z, abs=1)
    assert fib.find_fit(A, piv[:2], 19100.0, atr, [0.382, 0.5, 0.618], 0.5, 3) is None
    # 한 피벗이 여러 비율에 걸려도 1개로 센다
    assert fib.find_fit(A, piv[:1] * 1, 19100.0, atr, [0.382, 0.5, 0.618], 0.5, 3) is None
    # 하나가 어긋나면 2개만 남아 피팅 없음
    bad = piv[:2] + [(9, piv[2][1] + 80)]
    assert fib.find_fit(A, bad, 19100.0, atr, [0.382, 0.5, 0.618], 0.5, 3) is None


def _wave():
    A, Z = 20000.0, 19000.0
    pts = [19800, A, 19300, fib.level_price(Z, A, .618), 19250, fib.level_price(Z, A, .5),
           19150, fib.level_price(Z, A, .382), 19100, 19110]
    closes = [19800.0]
    for a, b in zip(pts[:-1], pts[1:]):
        closes += [a + (b - a) * (i + 1) / 8 for i in range(8)]
    prev, bars = closes[0], []
    for c in closes[1:]:
        bars.append((prev, max(prev, c) + 1, min(prev, c) - 1, c))
        prev = c
    return pd.DataFrame(bars, columns=["open", "high", "low", "close"]).assign(
        open_time=lambda d: np.arange(len(d)) * 900_000), Z


def test_auto_find_recovers_target_and_no_fit_on_noise():
    cfg = synth.cfg_for_tests()
    df, Z = _wave()
    atr = ind.atr(df).iloc[-1]
    f = fib.auto_find(df, atr, cfg)
    assert f and f["n_matches"] >= 3 and f["target"] == pytest.approx(Z + 1, abs=3)
    rng = np.random.default_rng(1)
    c = 20000 + np.cumsum(rng.normal(0, 30, 400))
    noise = pd.DataFrame({"open": c, "high": c + 10, "low": c - 10, "close": c,
                          "open_time": np.arange(400) * 900_000})
    assert fib.auto_find(noise, ind.atr(noise).iloc[-1], cfg) is None


def test_fit_prediction_is_frozen_in_db():
    st = Store(":memory:", source="live")
    st.insert_fit("SHORT", 1, 1000, 500, 20000.0, {"target": 19000.0})
    f = st.active_fit("SHORT")
    with pytest.raises(Exception, match="frozen"):
        st.conn.execute("UPDATE fits SET frozen_json='{}' WHERE id=?", (f["id"],))
    st.set_fit_status(f["id"], "reached", 2000, 2000)  # 결과 필드는 갱신 가능
    assert st.all_fits()[0]["frozen"]["target"] == 19000.0


def test_trend_short_long_wait_and_data_error():
    cfg = synth.cfg_for_tests()
    bars = synth.background(3600)
    for bs, want in ((bars, "SHORT"), (synth.mirror(bars), "LONG")):
        st = synth.build_store(bs)
        end = synth.close_of(len(bs) - 1)
        fr = {tf: st.load_candles(tf, end, 500) for tf in ("15m", "1h", "4h")}
        assert trend.decide(fr, cfg).direction == want
    flat = [synth.bar(20000 + (i % 2), 20000 + ((i + 1) % 2)) for i in range(3600)]
    st = synth.build_store(flat)
    end = synth.close_of(3599)
    d = trend.decide({tf: st.load_candles(tf, end, 500) for tf in ("15m", "1h", "4h")}, cfg)
    assert d.direction == "WAIT" and d.reasons
    with pytest.raises(DataError):
        trend.decide({"15m": st.load_candles("15m", end, 50), "1h": st.load_candles("1h", end, 50)}, cfg)


def test_overextension_means_wait():
    cfg = synth.cfg_for_tests(trend={"max_extension_pct": {"15m": 0.5, "1h": 12.0, "4h": 20.0}})
    bars = synth.background(3600)
    st = synth.build_store(bars)
    end = synth.close_of(3599)
    d = trend.decide({tf: st.load_candles(tf, end, 500) for tf in ("15m", "1h", "4h")}, cfg)
    assert d.direction == "WAIT" and any("이격" in r for r in d.reasons)
