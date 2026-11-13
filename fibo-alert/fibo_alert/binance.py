"""Binance USDⓈ-M Futures 공개 시장 데이터(REST/WebSocket). API 키 불필요."""
from __future__ import annotations

import logging
import time

import requests

from .util import now_ms, tf_ms

log = logging.getLogger("fibo.binance")
REST = "https://fapi.binance.com"
WS = "wss://fstream.binance.com/stream"


class BinanceRest:
    def __init__(self, session=None, sleep=time.sleep, base=REST, min_interval=0.25):
        self.s = session or requests.Session()
        self.sleep, self.base, self.min_interval = sleep, base, min_interval
        self._last = 0.0

    def klines(self, symbol, tf, start_ms=None, limit=1500):
        params = {"symbol": symbol, "interval": tf, "limit": limit}
        if start_ms is not None:
            params["startTime"] = int(start_ms)
        for attempt in range(6):
            gap = self.min_interval - (time.time() - self._last)
            if gap > 0:
                self.sleep(gap)
            self._last = time.time()
            try:
                r = self.s.get(f"{self.base}/fapi/v1/klines", params=params, timeout=15)
            except requests.RequestException as e:
                log.warning("klines network error %s", type(e).__name__)
                self.sleep(min(30, 2 ** attempt))
                continue
            if r.status_code == 200:
                return r.json()
            if r.status_code in (418, 429):  # 속도 제한/IP 밴: Retry-After 준수
                wait = float(r.headers.get("Retry-After", 2 ** (attempt + 1)))
                log.warning("binance rate limited (%s), sleeping %.0fs", r.status_code, wait)
                self.sleep(wait)
                continue
            if r.status_code >= 500:
                self.sleep(min(30, 2 ** attempt))
                continue
            r.raise_for_status()
        raise RuntimeError("binance klines failed after retries")

    def backfill(self, store, symbol, tf, since_ms=None, bars=None, now=None) -> int:
        """확정봉만 저장. since_ms 가 없으면 bars 개수만큼 과거부터."""
        m, now = tf_ms(tf), now or now_ms()
        if since_ms is None:
            since_ms = (now // m) * m - (bars or 1500) * m
        total, cur = 0, since_ms
        while True:
            rows = self.klines(symbol, tf, cur)
            closed = [(int(k[0]), k[1], k[2], k[3], k[4], k[5]) for k in rows if int(k[0]) + m <= now]
            if closed:
                total += store.upsert_candles(tf, closed)
                cur = closed[-1][0] + m
            if len(rows) < 1500 or not closed:
                break
        return total


def parse_kline_msg(msg: dict):
    """combined stream 메시지 → (tf, row) 또는 None. 확정(x=true) 봉만 반환."""
    d = msg.get("data", msg)
    k = d.get("k")
    if not k or not k.get("x"):
        return None
    return k["i"], (int(k["t"]), k["o"], k["h"], k["l"], k["c"], k["v"])


def ws_url(symbol, tfs):
    s = "/".join(f"{symbol.lower()}@kline_{tf}" for tf in tfs)
    return f"{WS}?streams={s}"
