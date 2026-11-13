"""피보나치 역산: 진행 중인 파동의 미래 종료점(0)을 중간 피벗들로 역산한다.

모든 함수는 '숏 세계'(1=시작 고점, 0=아래의 목표)에서 동작한다. 롱은 가격 부호를 뒤집은
거울 데이터를 넣어 동일 코드로 처리한다(engine.view 참고).

    0 = (피벗가격 - 비율 × 시작점가격) / (1 - 비율)
"""
from __future__ import annotations

import numpy as np

from .indicators import pivot_high_pos


def reverse_zero(pivot: float, start: float, ratio: float) -> float:
    return (pivot - ratio * start) / (1.0 - ratio)


def level_price(zero: float, start: float, ratio: float) -> float:
    return zero + ratio * (start - zero)


def find_fit(start_price, pivots, min_low, atr, ratios, tol_atr, min_matches):
    """pivots: [(time, price)] — 시작점 이후 확정된 피벗 고점. 독립된 피벗 min_matches 개 이상이
    tol_atr×ATR 폭 안에서 같은 0 으로 모이는 가장 좋은 군집을 돌려준다. 없으면 None."""
    tol = tol_atr * atr
    if tol <= 0:
        return None
    cands = []
    for t, p in pivots:
        if not p < start_price:
            continue
        for r in ratios:
            z = reverse_zero(p, start_price, r)
            if z < min_low:  # 0 은 지금까지의 최저점보다 아래(미래)여야 한다
                cands.append((z, t, p, r))
    if len(cands) < min_matches:
        return None
    cands.sort()
    zs = [c[0] for c in cands]
    best = None
    for i in range(len(cands)):
        j = i
        while j + 1 < len(cands) and zs[j + 1] - zs[i] <= tol:
            j += 1
        window = cands[i:j + 1]
        med = float(np.median([c[0] for c in window]))
        by = {}
        for c in window:  # 피벗 하나는 한 번만 센다(독립성)
            if c[1] not in by or abs(c[0] - med) < abs(by[c[1]][0] - med):
                by[c[1]] = c
        chosen = sorted(by.values(), key=lambda c: c[1])
        if len(chosen) < min_matches:
            continue
        zc = np.array([c[0] for c in chosen])
        center = float(zc.mean())
        err = float(np.abs(zc - center).mean())
        width = float(zc.max() - zc.min())
        score = len(chosen) + (1 - err / tol) + 0.5 * (1 - width / tol)
        key = (len(chosen), score)
        if best is None or key > best[0]:
            best = (key, chosen, center, err, width, score, float(zc.min()), float(zc.max()))
    if best is None:
        return None
    _, chosen, center, err, width, score, lo, hi = best
    return {
        "target": center, "zone_lo": lo, "zone_hi": hi, "n_matches": len(chosen),
        "mean_err": err, "mean_err_atr": err / atr, "zone_width": width, "score": score,
        "matches": [{"time": int(c[1]), "price": float(c[2]), "ratio": float(c[3]), "z": float(c[0])}
                    for c in chosen],
    }


def _fit_for_start(s, highs, lows, times, piv_pos, atr, cfg, ratios):
    A = float(highs[s])
    if highs[s:].max() > A:  # 시작 고점은 이후 최고점이어야 한다
        return None
    min_low = float(lows[s:].min())
    if A - min_low < cfg.fib.min_wave_atr * atr:
        return None
    pivots = [(int(times[p]), float(highs[p])) for p in piv_pos if p > s]
    f = find_fit(A, pivots, min_low, atr, ratios, cfg.fib.tolerance_atr, cfg.fib.min_matches)
    if f is None:
        return None
    f.update(start_time=int(times[s]), start_price=A, min_low=min_low, atr=float(atr),
             pivots=[[t, p] for t, p in pivots], ratios=list(ratios))
    return f


def auto_find(view, atr, cfg, ratios=None):
    """자동 시작점 탐지. 결과가 불명확(서로 다른 시작점이 비슷한 점수로 다른 목표를 가리킴)하면 None."""
    ratios = ratios or list(cfg.fib.ratios)
    highs, lows, times = view["high"].values, view["low"].values, view["open_time"].values
    piv = pivot_high_pos(highs, cfg.noise.pivot_lr)
    lo = max(0, len(view) - cfg.fib.lookback_bars)
    fits = []
    for s in piv[piv >= lo]:
        f = _fit_for_start(int(s), highs, lows, times, piv, atr, cfg, ratios)
        if f:
            fits.append(f)
    if not fits:
        return None
    fits.sort(key=lambda f: -f["score"])
    best, tol = fits[0], cfg.fib.tolerance_atr * atr
    for o in fits[1:]:
        if (best["score"] - o["score"] < cfg.fib.ambiguity_score_margin
                and abs(o["target"] - best["target"]) > tol):
            return None
    return best


def manual_find(view, start_time, start_price, atr, cfg, ratios=None):
    ratios = ratios or list(cfg.fib.ratios)
    highs, lows, times = view["high"].values, view["low"].values, view["open_time"].values
    idx = np.nonzero(times == start_time)[0]
    if len(idx) == 0:
        return None
    s = int(idx[0])
    if start_price is not None and abs(highs[s] - start_price) > 1e-9:
        return None
    piv = pivot_high_pos(highs, cfg.noise.pivot_lr)
    return _fit_for_start(s, highs, lows, times, piv, atr, cfg, ratios)
