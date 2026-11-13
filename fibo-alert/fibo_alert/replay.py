"""저장된 봉으로 엔진을 처음부터 다시 돌린다(백테스트·라이브 일치 검증 공용)."""
from __future__ import annotations

from .engine import Engine
from .store import Store
from .util import tf_ms

TFS = ("15m", "1h", "4h")


def copy_candles(src: Store, dst: Store):
    for tf in TFS:
        rows = src.conn.execute("SELECT open_time,open,high,low,close,volume FROM candles "
                                "WHERE symbol=? AND tf=? ORDER BY open_time", (src.symbol, tf)).fetchall()
        if rows:
            dst.upsert_candles(tf, rows)


def run_replay(src: Store, cfg, start_close=None, end_close=None, path=":memory:"):
    """src 의 봉으로 start_close..end_close(15m 종료시각) 구간을 순서대로 step. 결과 Store(source=replay)."""
    dst = Store(path, cfg.symbol, source="replay")
    copy_candles(src, dst)
    m = tf_ms(cfg.trigger_tf)
    first = src.first_open(cfg.trigger_tf)
    last = src.last_open(cfg.trigger_tf)
    warm = first + cfg.history_bars["15m"] * m // 2 if first is not None else 0
    start_close = start_close or max(warm, first + 500 * m)
    end_close = end_close or (last + m)
    eng, errors, c = Engine(cfg, dst), [], start_close
    while c <= end_close:
        r = eng.step(c)
        if r.status != "OK":
            errors.append((c, r.detail))
        c += m
    return dst, errors


def verify(live: Store, cfg):
    """라이브 DB 의 전이·알림 이력이 같은 봉 데이터의 리플레이와 일치하는지 비교."""
    first = live.get_meta("first_step_close")
    last = live.get_meta("last_close")
    if first is None or last is None:
        return {"ok": False, "detail": "라이브 처리 이력이 없음"}
    rep, errors = run_replay(live, cfg, first, last)
    key = lambda rows: {(r[0], r[1], r[2], r[3]) for r in rows}  # noqa: E731
    lt, rt = key(live.transitions()), key(rep.transitions())
    la = {k for k in live.alert_keys() if not k.startswith("OPS|")}
    ra = rep.alert_keys()
    fits_l = {(f["side"], f["version"], f["frozen"]["target"]) for f in live.all_fits()}
    fits_r = {(f["side"], f["version"], f["frozen"]["target"]) for f in rep.all_fits()}
    ok = lt == rt and la == ra and fits_l == fits_r and not errors
    return {"ok": ok, "transitions_only_live": sorted(lt - rt), "transitions_only_replay": sorted(rt - lt),
            "alerts_only_live": sorted(la - ra), "alerts_only_replay": sorted(ra - la),
            "fits_only_live": sorted(fits_l - fits_r), "fits_only_replay": sorted(fits_r - fits_l),
            "replay_errors": errors, "n_transitions": len(lt), "n_alerts": len(la)}
