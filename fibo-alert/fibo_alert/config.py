from __future__ import annotations

import copy
import os
from typing import Any

import yaml

DEFAULTS: dict[str, Any] = {
    "symbol": "BTCUSDT",
    "trigger_tf": "15m",
    "display_tz": "Asia/Seoul",
    "db_path": "data/fibo.db",
    "history_bars": {"15m": 1500, "1h": 1000, "4h": 600},
    "gap_check_bars": 250,
    "trend": {
        "ema_period": 200,
        "slope_lookback": 20,
        "slope_threshold_pct": {"15m": 0.10, "1h": 0.10, "4h": 0.10},
        "max_extension_pct": {"15m": 3.0, "1h": 6.0, "4h": 10.0},
        "use_4h_filter": False,
    },
    "noise": {
        "atr_period": 14,
        "breakout_atr": 0.35,
        "breakout_body_ratio": 0.70,
        "breakout_confirm_closes": 3,
        "pivot_lr": 5,
        "retest_atr": 0.25,
        "retest_max_bars": 16,
        "sl_buffer_atr": 0.25,
    },
    "fib": {
        "ratios": [0.236, 0.382, 0.5, 0.618, 0.786],
        "entry_levels": [0.382, 0.5, 0.618, 0.786],
        "min_matches": 3,
        "tolerance_atr": 0.5,
        "lookback_bars": 600,
        "start_mode": "auto",  # auto | manual
        "manual_start": {"side": "SHORT", "time": None, "price": None},
        "min_wave_atr": 6.0,
        "ambiguity_score_margin": 0.75,
        "fit_max_bars": 1000,
    },
    "entry": {
        "min_rr": 3.0,
        "zone_atr": 0.5,
        "approach_atr": 1.0,
        "double_top_tol_atr": 0.25,
        "lower_high_max_atr": 1.5,
        "watch_max_bars": 96,
        "breakout_wait_bars": 96,
        "max_position_bars": 672,
        "notify_rr_reject": False,
    },
    "costs": {"fee_rate_per_side": 0.0005, "slippage_bps_per_side": 2.0, "leverage": 100},
    "alerts": {
        "stale_alert_minutes": 60,
        "notify_virtual_close": True,
        "max_attempts": 5,
        "min_interval_s": 0.6,
    },
    "ops": {"disconnect_alert_after_s": 120, "ws_idle_timeout_s": 60},
    "backtest": {"horizon_bars": 384, "random_trials": 200, "seed": 7},
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Cfg:
    """dict 를 속성 접근으로 감싼다. cfg.noise.pivot_lr / cfg.trend['slope_threshold_pct']"""

    def __init__(self, d: dict):
        object.__setattr__(self, "_d", d)

    def __getattr__(self, k):
        try:
            v = self._d[k]
        except KeyError:
            raise AttributeError(k) from None
        return Cfg(v) if isinstance(v, dict) else v

    def __getitem__(self, k):
        v = self._d[k]
        return Cfg(v) if isinstance(v, dict) else v

    def to_dict(self) -> dict:
        return copy.deepcopy(self._d)


def load_config(path: str | None = None, overrides: dict | None = None) -> Cfg:
    data: dict = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    merged = _merge(DEFAULTS, data)
    if overrides:
        merged = _merge(merged, overrides)
    return Cfg(merged)
