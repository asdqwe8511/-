import json
import random

import pytest

import scenario
import synth
from fibo_alert import report
from fibo_alert.engine import Engine
from fibo_alert.replay import run_replay, verify
from fibo_alert.store import Store
from synth import bar, ramp

N0 = 3600


def run(bars, monkeypatch, mirror=False, cfg=None, start=N0 - 3, **kw):
    scenario.install_fake_fit(monkeypatch, N0 - 5, mirror)
    st = synth.build_store(bars)
    cfg = cfg or synth.cfg_for_tests()
    rep, errs = run_replay(st, cfg, synth.close_of(start), synth.close_of(len(bars) - 1), **kw)
    assert errs == []
    return st, rep, cfg


def trans(rep):
    return [(k.split("|", 2)[2], f, t) for k, f, t, *_ in rep.transitions()]


def kinds(rep):
    return [r[0] for r in rep.conn.execute("SELECT kind FROM alerts ORDER BY id")]


@pytest.mark.parametrize("mirror,side", [(False, "SHORT"), (True, "LONG")])
def test_pattern_b_full_lifecycle_and_long_symmetry(monkeypatch, mirror, side):
    _, rep, _ = run(scenario.make(mirror), monkeypatch, mirror)
    t = [x for x in trans(rep) if x[0] == "v1|B|0.5"]
    assert [x[2] for x in t] == ["WATCHING", "BREAKOUT_CONFIRMED", "RETEST_PENDING", "ENTRY_CANDIDATE",
                                 "TARGET_REACHED", "TRAILING", "CLOSED"]
    assert kinds(rep) == ["APPROACH", "APPROACH", "ENTRY", "TARGET", "TRAIL", "CLOSE"]
    entry = json.loads(rep.conn.execute("SELECT payload_json FROM alerts WHERE kind='ENTRY'").fetchone()[0])
    assert entry["side"] == side and entry["risk"]["rr"] >= 3 and entry["n_matches"] == 3
    sg = 1 if side == "SHORT" else -1
    if side == "SHORT":
        assert entry["sl"] > entry["entry"] > entry["target"]
    else:
        assert entry["sl"] < entry["entry"] < entry["target"]
    res = [s.ctx["result"] for s in rep.load_signals() if "result" in s.ctx][0]
    assert res["reached_target"] and res["outcome"] == "TRAILING_STOP" and res["R_gross"] > 5
    # 후행 SL 은 유리한 방향으로만 움직였다
    pos = [s for s in rep.load_signals() if "position" in s.ctx][0].ctx["position"]
    assert pos["sl"] < pos["sl0"] and sg


def test_pattern_a_double_top_neckline(monkeypatch):
    tail = (ramp(19000, 19195, 10) + ramp(19195, 19120, 8) + ramp(19120, 19197, 8)
            + ramp(19197, 19100, 12) + ramp(19100, 18690, 30))
    _, rep, _ = run(scenario.make(tail=tail), monkeypatch)
    t = [x for x in trans(rep) if x[0] == "v1|A|0.5"]
    assert [x[2] for x in t][:3] == ["WATCHING", "RETEST_PENDING", "ENTRY_CANDIDATE"]
    e = json.loads(rep.conn.execute("SELECT payload_json FROM alerts WHERE kind='ENTRY'").fetchone()[0])
    assert e["pattern"] == "A" and "더블탑" in e["why"] and e["risk"]["rr"] >= 3


def test_no_entry_alert_below_min_rr(monkeypatch):
    cfg = synth.cfg_for_tests(entry={"min_rr": 50.0})
    _, rep, _ = run(scenario.make(), monkeypatch, cfg=cfg)
    assert "ENTRY" not in kinds(rep)
    assert any("rr_below_min" in r for *_, r in rep.transitions())


def test_retest_timeout_and_level_recovery(monkeypatch):
    base = ramp(19000, 19180, 9) + [bar(19185, 19262, 19264, 19183), bar(19262, 19270), bar(19270, 19280),
                                    bar(19280, 19190, 19282, 19188)]
    timeout = base + ramp(19190, 19140, 20)  # 리테스트 없이 하락 → 16봉 초과
    _, rep, _ = run(scenario.make(tail=timeout), monkeypatch)
    assert ("v1|B|0.5", "RETEST_PENDING", "TIMEOUT") in trans(rep)
    assert "INVALID" in kinds(rep) and "ENTRY" not in kinds(rep)
    recov = base + [bar(19190, 19215, 19217, 19188), bar(19215, 19240)] + ramp(19240, 19300, 5)
    _, rep, _ = run(scenario.make(tail=recov), monkeypatch)
    assert ("v1|B|0.5", "RETEST_PENDING", "INVALIDATED") in trans(rep)


def test_trend_conflict_invalidates(monkeypatch):
    # 접근 후 급등으로 EMA 위로 올라가면(위치 불일치) 이후 단계 신호는 무효화된다
    tail = ramp(19000, 19180, 9) + ramp(19180, 21500, 30, wick=5) + ramp(21500, 21400, 5)
    cfg = synth.cfg_for_tests(trend={"max_extension_pct": {"15m": 30.0, "1h": 30.0, "4h": 30.0}})
    _, rep, _ = run(scenario.make(tail=tail), monkeypatch, cfg=cfg)
    assert any("추세 충돌" in r for *_, r in rep.transitions())
    assert "INVALID" in kinds(rep)
    assert "ENTRY" not in kinds(rep)


def test_signal_only_from_closed_bars_and_missing_bar_is_data_error(monkeypatch):
    bars = scenario.make()
    scenario.install_fake_fit(monkeypatch, N0 - 5)
    st = synth.build_store(bars)
    eng = Engine(synth.cfg_for_tests(), st)
    c = synth.close_of(N0 + 5)
    st.conn.execute("DELETE FROM candles WHERE tf='15m' AND open_time=?", (c - 900_000,))
    r = eng.step(c)
    assert r.status == "DATA_ERROR" and st.get_meta("engine_status")["state"] == "DATA_ERROR"
    assert st.get_meta("last_close") is None and not st.transitions()  # 관망으로 위장하지 않고 멈춘다
    # 아직 닫히지 않은 봉(종료시각 > close)은 로드되지 않는다
    df = st.load_candles("15m", synth.close_of(100), 50)
    assert df["open_time"].iloc[-1] + 900_000 <= synth.close_of(100)


def test_no_lookahead_future_changes_do_not_alter_past(monkeypatch):
    bars = scenario.make()
    cut = N0 + 30
    _, rep1, _ = run(bars, monkeypatch)
    rnd = random.Random(3)
    fut = bars[:cut] + [bar(p, p + rnd.uniform(-300, 300)) for p in [19000.0] * (len(bars) - cut)]
    _, rep2, _ = run(fut, monkeypatch)
    limit = synth.close_of(cut - 1)
    a = [t for t in rep1.transitions() if t[3] <= limit]
    b = [t for t in rep2.transitions() if t[3] <= limit]
    assert a == b and len(a) > 5
    f1, f2 = rep1.all_fits()[0]["frozen"], rep2.all_fits()[0]["frozen"]
    assert f1["target"] == f2["target"]  # 예측 목표는 이후 데이터에 의해 바뀌지 않는다


def test_restart_resumes_without_duplicate_alerts(monkeypatch, tmp_path):
    bars = scenario.make()
    scenario.install_fake_fit(monkeypatch, N0 - 5)
    cfg = synth.cfg_for_tests()
    src = synth.build_store(bars)
    ref, _ = run_replay(src, cfg, synth.close_of(N0 - 3), synth.close_of(len(bars) - 1))
    path = str(tmp_path / "live.db")
    live = synth.build_store(bars, path)
    m = 900_000
    eng, c = Engine(cfg, live), synth.close_of(N0 - 3)
    while c <= synth.close_of(N0 + 20):
        assert eng.step(c).status == "OK"
        c += m
    live.conn.close()
    live = Store(path, cfg.symbol, "live")  # 재시작
    eng = Engine(cfg, live)
    c = live.get_meta("last_close") + m
    while c <= synth.close_of(len(bars) - 1):
        assert eng.step(c).status == "OK"
        c += m
    keys = [r[0] for r in live.conn.execute("SELECT dedupe_key FROM alerts")]
    assert len(keys) == len(set(keys))
    assert set(keys) == ref.alert_keys()
    # 같은 알림을 다시 넣어도 중복 저장되지 않는다
    assert live.add_alert(keys[0], "ENTRY", None, 1, {}) is False


def test_live_vs_replay_verification(monkeypatch):
    bars = scenario.make()
    scenario.install_fake_fit(monkeypatch, N0 - 5)
    cfg = synth.cfg_for_tests()
    live = synth.build_store(bars)
    live.set_meta("first_step_close", synth.close_of(N0 - 3))
    eng, c = Engine(cfg, live), synth.close_of(N0 - 3)
    while c <= synth.close_of(len(bars) - 1):
        eng.step(c, now_ms=c)
        c += 900_000
    v = verify(live, cfg)
    assert v["ok"], v
    live.conn.execute("DELETE FROM alerts WHERE kind='TARGET'")  # 이력이 어긋나면 잡아낸다
    assert not verify(live, cfg)["ok"]


def test_stale_alert_is_suppressed_not_sent(monkeypatch):
    bars = scenario.make()
    scenario.install_fake_fit(monkeypatch, N0 - 5)
    st = synth.build_store(bars)
    eng, c = Engine(synth.cfg_for_tests(), st), synth.close_of(N0 - 3)
    while c <= synth.close_of(N0 + 20):
        eng.step(c, now_ms=c + 5 * 3_600_000)  # 5시간 늦게 처리
        c += 900_000
    assert st.conn.execute("SELECT COUNT(*) FROM alerts WHERE status='pending'").fetchone()[0] == 0
    assert st.conn.execute("SELECT COUNT(*) FROM alerts WHERE status='suppressed_stale'").fetchone()[0] > 0


def test_report_separates_replay_and_computes_metrics(monkeypatch):
    _, rep, cfg = run(scenario.make(), monkeypatch)
    cfg2 = synth.cfg_for_tests(backtest={"random_trials": 20})
    d = report.build(rep, cfg2)
    assert "HYPOTHETICAL" in d["label"] and d["fits"]["n"] == 1
    assert d["fits"]["reach_rate"] == 1.0
    a = d["trades"]["ALL"]
    assert a["entries"] == 1 and a["closed"] == 1 and a["target_reach_rate"] == 1.0
    assert a["expectancy_R_net"] > 0 and d["trades"]["LONG"]["entries"] == 0
    assert "random_baseline" in d and d["random_baseline"]["trials"] == 20 * 1
