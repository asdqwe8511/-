"""EMA200 위치·기울기·이격으로 매매 허용 방향 판정. 확정봉만 입력받는다."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .indicators import ema, slope_pct
from .util import DataError, IndicatorError


@dataclass
class TrendDecision:
    direction: str  # SHORT | LONG | WAIT
    reasons: list[str] = field(default_factory=list)
    per_tf: dict = field(default_factory=dict)

    def summary(self) -> list[dict]:
        return [dict(tf=k, **v) for k, v in self.per_tf.items()]


def tf_state(df, tf, cfg):
    t = cfg.trend
    need = 2 * t.ema_period
    if len(df) < need:
        raise DataError(f"{tf}: {len(df)} bars < {need} needed for EMA{t.ema_period}")
    e = ema(df["close"], t.ema_period)
    close, e_last = float(df["close"].iloc[-1]), float(e.iloc[-1])
    if not (np.isfinite(close) and np.isfinite(e_last)) or e_last <= 0:
        raise IndicatorError(f"{tf}: invalid close/EMA")
    sl = slope_pct(e, t.slope_lookback)
    thr = float(t.slope_threshold_pct[tf])
    ext = (close / e_last - 1.0) * 100.0
    return {
        "close": close, "ema": e_last, "slope_pct": sl, "ext_pct": ext,
        "pos": "above" if close > e_last else "below",
        "slope": "up" if sl > thr else "down" if sl < -thr else "flat",
        "max_ext_pct": float(t.max_extension_pct[tf]),
    }


def decide(frames: dict, cfg) -> TrendDecision:
    tfs = ["15m", "1h"] + (["4h"] if cfg.trend.use_4h_filter else [])
    per, dirs, reasons = {}, [], []
    for tf in tfs:
        s = tf_state(frames[tf], tf, cfg)
        per[tf] = s
        if s["pos"] == "below" and s["slope"] == "down":
            dirs.append("SHORT")
        elif s["pos"] == "above" and s["slope"] == "up":
            dirs.append("LONG")
        else:
            dirs.append(None)
            reasons.append(f"{tf}: " + ("EMA200 기울기 중립" if s["slope"] == "flat"
                                        else "EMA200 위치·기울기 불일치"))
        if abs(s["ext_pct"]) > s["max_ext_pct"]:
            reasons.append(f"{tf}: EMA200 과도한 이격 {s['ext_pct']:+.2f}%")
    if None not in dirs and len(set(dirs)) > 1:
        reasons.append("시간봉 간 추세 충돌")
    if reasons or None in dirs or len(set(dirs)) != 1:
        return TrendDecision("WAIT", reasons, per)
    return TrendDecision(dirs[0], [], per)
