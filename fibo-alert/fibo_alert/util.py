from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

TF_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000}


class DataError(Exception):
    """시장 데이터가 부족하거나 끊겨 있음. '관망'으로 위장하지 않고 상위로 올린다."""


class IndicatorError(Exception):
    """지표 계산 결과가 유효하지 않음(NaN 등)."""


def tf_ms(tf: str) -> int:
    return TF_MS[tf]


def now_ms() -> int:
    return int(time.time() * 1000)


def _tz(name: str):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # tzdata 없는 환경
        return timezone(timedelta(hours=9)) if name == "Asia/Seoul" else timezone.utc


def fmt_utc(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def fmt_local(ms: int, tz: str = "Asia/Seoul") -> str:
    d = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(_tz(tz))
    return d.strftime("%Y-%m-%d %H:%M ") + ("KST" if tz == "Asia/Seoul" else tz)


def parse_utc(s: str) -> int:
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def fmt_price(x: float) -> str:
    return f"{x:,.1f}"
