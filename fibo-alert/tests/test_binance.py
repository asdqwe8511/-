from fibo_alert.binance import BinanceRest, parse_kline_msg, ws_url
from fibo_alert.store import Store

M = 900_000


class R:
    def __init__(self, code, data=None, headers=None):
        self.status_code, self._d, self.headers = code, data, headers or {}

    def json(self):
        return self._d

    def raise_for_status(self):
        raise RuntimeError(self.status_code)


class S:
    def __init__(self, resp):
        self.resp, self.calls = list(resp), []

    def get(self, url, params=None, timeout=None):
        self.calls.append(params)
        return self.resp.pop(0)


def k(t):
    return [t, "1", "2", "0.5", "1.5", "10"]


def test_backfill_drops_unclosed_bar_and_honours_retry_after():
    sleeps = []
    now = 10 * M + 5000
    s = S([R(429, None, {"Retry-After": "7"}), R(200, [k(7 * M), k(8 * M), k(9 * M), k(10 * M)])])
    rest = BinanceRest(s, sleep=sleeps.append)
    st = Store(":memory:")
    n = rest.backfill(st, "BTCUSDT", "15m", 7 * M, now=now)
    assert n == 3 and st.last_open("15m") == 9 * M  # 10M 봉은 진행 중 → 저장 안 함
    assert 7.0 in sleeps


def test_ws_only_closed_klines():
    msg = {"stream": "btcusdt@kline_15m", "data": {"k": {"t": 5, "i": "15m", "o": "1", "h": "2", "l": "0", "c": "1", "v": "3", "x": False}}}
    assert parse_kline_msg(msg) is None
    msg["data"]["k"]["x"] = True
    assert parse_kline_msg(msg) == ("15m", (5, "1", "2", "0", "1", "3"))
    assert "btcusdt@kline_1h" in ws_url("BTCUSDT", ["15m", "1h"])
