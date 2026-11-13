from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from .util import IndicatorError


def ema(close: pd.Series, period: int) -> pd.Series:
    return close.ewm(span=period, adjust=False).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder ATR. 상하 반전(롱↔숏 거울)에도 값이 같다."""
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    tr.iloc[0] = df["high"].iloc[0] - df["low"].iloc[0]
    return tr.ewm(alpha=1.0 / period, adjust=False).mean()


def pivot_high_pos(high: np.ndarray, lr: int) -> np.ndarray:
    """좌우 lr 봉 기준 확정 피벗 고점의 위치.

    i 는 왼쪽 lr 봉보다 엄격히 높고 오른쪽 lr 봉보다 같거나 높아야 한다(동일 고점은 처음 것만).
    오른쪽 lr 봉이 아직 없는 마지막 lr 봉은 후보가 될 수 없다 → 미확정 피벗 사용 금지.
    """
    n = len(high)
    if n < 2 * lr + 1:
        return np.array([], dtype=int)
    win = sliding_window_view(high, 2 * lr + 1)  # win[k] 의 중심은 k+lr
    center = win[:, lr]
    left = win[:, :lr].max(axis=1)
    right = win[:, lr + 1:].max(axis=1)
    ok = (center > left) & (center >= right)
    return np.nonzero(ok)[0] + lr


def pivot_low_pos(low: np.ndarray, lr: int) -> np.ndarray:
    return pivot_high_pos(-low, lr)


def slope_pct(ema_s: pd.Series, lookback: int) -> float:
    if len(ema_s) <= lookback:
        raise IndicatorError("slope: not enough EMA values")
    prev = float(ema_s.iloc[-1 - lookback])
    if prev == 0 or not np.isfinite(prev):
        raise IndicatorError("slope: invalid EMA")
    return (float(ema_s.iloc[-1]) / prev - 1.0) * 100.0
