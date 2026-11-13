"""리플레이(가상) 결과 리포트. 라이브 신호와 섞지 않는다 — source='replay' 만 집계한다."""
from __future__ import annotations

import json

import numpy as np

from .engine import view
from .fib import find_fit
from .util import tf_ms


def reach_eval(v, created_close, A, Z, horizon, m):
    """생성 시점 이후 봉(v: 숏세계)에서 Z 도달 여부. (reached, bars, invalidated). 시작점 상향 돌파 시 무효."""
    sel = v[v["open_time"] >= created_close].head(horizon)
    if sel.empty:
        return None
    hi, lo = sel["high"].values, sel["low"].values
    inv = np.nonzero(hi > A)[0]
    hit = np.nonzero(lo <= Z)[0]
    i_inv = inv[0] if len(inv) else 10**9
    i_hit = hit[0] if len(hit) else 10**9
    if i_hit < i_inv:
        return True, int(i_hit) + 1, False
    return False, None, i_inv < 10**9


def _stats(r):
    r = np.array(r, dtype=float)
    return (float(r.mean()), float(np.median(r))) if len(r) else (None, None)


def _max_dd(rs):
    eq = np.cumsum(rs) if len(rs) else np.array([0.0])
    peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))
    return float((peak[1:] - eq).max()) if len(rs) else 0.0


def build(rep, cfg) -> dict:
    """rep: replay Store."""
    m = tf_ms(cfg.trigger_tf)
    bt = cfg.backtest
    base = rep.load_candles("15m", 10**15, 10**7)
    fits = rep.all_fits()
    out = {"label": "HYPOTHETICAL REPLAY — 사후 계산, 실시간 예측 성과 아님(검증 전)", "fits": {}, "trades": {}}

    # --- 피팅 성과
    ev = []
    for f in fits:
        fz = f["frozen"]
        v = view(base, f["side"])
        e = reach_eval(v, f["created_close"], fz["start_price"], fz["target"], bt.horizon_bars, m)
        if e:
            ev.append((f, e))
    reached = [(f, e) for f, e in ev if e[0]]
    out["fits"] = {
        "n": len(ev), "horizon_bars": bt.horizon_bars,
        "reach_rate": len(reached) / len(ev) if ev else None,
        "bars_to_reach_mean": float(np.mean([e[1] for _, e in reached])) if reached else None,
        "bars_to_reach_median": float(np.median([e[1] for _, e in reached])) if reached else None,
        "matches_mean": float(np.mean([f["frozen"]["n_matches"] for f, _ in ev])) if ev else None,
        "fit_err_atr_mean": float(np.mean([f["frozen"]["mean_err_atr"] for f, _ in ev])) if ev else None,
        "invalidated_rate": sum(1 for _, e in ev if e[2]) / len(ev) if ev else None,
    }

    # --- 무작위 비율군 대비
    rng = np.random.default_rng(bt.seed)
    trials = fit_cnt = hit_cnt = 0
    for f, _ in ev:
        fz = f["frozen"]
        v = view(base, f["side"])
        piv = [tuple(x) for x in fz["pivots"]]
        for _ in range(bt.random_trials):
            ratios = sorted(rng.uniform(0.1, 0.9, size=len(fz["ratios"])).round(3).tolist())
            trials += 1
            g = find_fit(fz["start_price"], piv, fz["min_low"], fz["atr"], ratios,
                         cfg.fib.tolerance_atr, cfg.fib.min_matches)
            if g is None:
                continue
            fit_cnt += 1
            e = reach_eval(v, f["created_close"], fz["start_price"], g["target"], bt.horizon_bars, m)
            hit_cnt += bool(e and e[0])
    out["random_baseline"] = {
        "trials": trials, "fit_found_rate": fit_cnt / trials if trials else None,
        "reach_rate_given_fit": hit_cnt / fit_cnt if fit_cnt else None,
        "real_reach_rate": out["fits"]["reach_rate"],
        "note": "실제 비율군의 도달률이 무작위 비율군보다 의미 있게 높은지 표본 수와 함께 해석할 것",
    }

    # --- 가상 거래
    res = [s.ctx["result"] for s in rep.load_signals() if "result" in s.ctx]
    entries = [s for s in rep.load_signals() if "position" in s.ctx]

    def block(rs, n_entries):
        if not n_entries:
            return {"entries": 0}
        rg = [r["R_gross"] for r in rs]
        rn = [r["R_net"] for r in rs]
        tgt = [r for r in rs if r["reached_target"]]
        return {
            "entries": n_entries, "closed": len(rs),
            "initial_sl_rate": sum(r["outcome"] == "STOP_LOSS" for r in rs) / len(rs) if rs else None,
            "target_reach_rate": len(tgt) / len(rs) if rs else None,
            "bars_to_target_mean": float(np.mean([r["bars_to_target"] for r in tgt])) if tgt else None,
            "mfe_R_mean": float(np.mean([r["mfe_R"] for r in rs])) if rs else None,
            "mae_R_mean": float(np.mean([r["mae_R"] for r in rs])) if rs else None,
            "ext_after_target_R_mean": float(np.mean([r["ext_after_target_R"] for r in tgt])) if tgt else None,
            "R_trailing_gross_mean": _stats(rg)[0], "expectancy_R_net": _stats(rn)[0],
            "max_drawdown_R": _max_dd(rn),
        }
    out["trades"]["ALL"] = block(res, len(entries))
    for side in ("SHORT", "LONG"):
        out["trades"][side] = block([r for r in res if r["side"] == side],
                                    sum(1 for s in entries if s.side == side))
    out["trades"]["open_at_end"] = len(entries) - len(res)
    return out


def render(rep_dict) -> str:
    return json.dumps(rep_dict, ensure_ascii=False, indent=2, default=float)
