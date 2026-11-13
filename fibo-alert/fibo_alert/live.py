"""상시 실행 루프: WebSocket 확정봉 수신 → 누락 복구 → 엔진 step → Discord 전송."""
from __future__ import annotations

import asyncio
import json
import logging
import time

from .binance import BinanceRest, parse_kline_msg, ws_url
from .engine import Engine
from .util import fmt_utc, now_ms, tf_ms

log = logging.getLogger("fibo.live")


class Runner:
    def __init__(self, cfg, store, notifier, rest=None):
        self.cfg, self.st, self.notifier = cfg, store, notifier
        self.rest = rest or BinanceRest()
        self.engine = Engine(cfg, store)
        self.tfs = ["15m", "1h", "4h"]
        self.m = tf_ms(cfg.trigger_tf)
        self.q: asyncio.Queue = asyncio.Queue()
        self.connected = False
        self.down_since: float | None = None
        self.down_alerted = False

    # ---- 데이터 복구 / 처리 (동기; to_thread 로 실행)
    def bootstrap(self):
        for tf in self.tfs:
            last = self.st.last_open(tf)
            since = None if last is None else last + tf_ms(tf)
            n = self.rest.backfill(self.st, self.cfg.symbol, tf, since, self.cfg.history_bars[tf] + 50)
            log.info("backfill %s: %d bars", tf, n)

    def _ensure_htf(self, close_ms) -> bool:
        for tf in self.tfs[1:]:
            m = tf_ms(tf)
            if close_ms % m:
                continue
            need = close_ms - m
            for _ in range(8):
                if (self.st.last_open(tf) or 0) >= need:
                    break
                self.rest.backfill(self.st, self.cfg.symbol, tf, (self.st.last_open(tf) or need - m * 5) + m)
                if (self.st.last_open(tf) or 0) >= need:
                    break
                time.sleep(1.5)  # 거래소가 막 닫힌 봉을 REST 에 올리는 데 걸리는 시간
            else:
                return False
        return True

    def process(self):
        now = now_ms()
        latest = (now // self.m) * self.m
        last = self.st.get_meta("last_close")
        if last is None:
            self.st.set_meta("first_step_close", latest)
            last = latest - self.m
        if latest <= last:
            self.notifier.flush()
            return
        # 15m 누락 복구 후 누락된 봉도 순서대로 모두 처리(상태 머신 연속성 유지)
        self.rest.backfill(self.st, self.cfg.symbol, "15m", (self.st.last_open("15m") or 0) + self.m)
        c = last + self.m
        while c <= latest:
            if not self._ensure_htf(c) or (self.st.last_open("15m") or 0) < c - self.m:
                self._ops("데이터 대기", f"{fmt_utc(c)} 봉 데이터를 아직 받지 못함. 재시도합니다.", f"wait|{c}")
                break
            r = self.engine.step(c, now_ms())
            if r.status != "OK":
                log.error("engine data error: %s", r.detail)
                self._ops("데이터/지표 오류", f"{fmt_utc(c)} 처리 중단(관망으로 처리하지 않음): {r.detail}",
                          f"dataerr|{c // 3_600_000}")
                break
            c += self.m
        self.notifier.flush()

    def _ops(self, title, detail, key):
        self.st.add_alert(f"OPS|{key}", "OPS", None, now_ms(), {
            "kind": "OPS", "title": title, "detail": detail, "bar_close": now_ms(), "virtual": False,
            "symbol": self.cfg.symbol})

    # ---- 비동기 루프
    async def ws_loop(self):
        import websockets
        url, backoff = ws_url(self.cfg.symbol, self.tfs), 1
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                    log.info("ws connected")
                    self._up()
                    backoff = 1
                    await self.q.put(None)  # 재연결 직후 누락 복구
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), timeout=self.cfg.ops.ws_idle_timeout_s)
                        k = parse_kline_msg(json.loads(raw))
                        if k:
                            tf, row = k
                            self.st.upsert_candles(tf, [row])
                            if tf == self.cfg.trigger_tf:
                                await self.q.put(row[0])
            except Exception as e:
                log.warning("ws disconnected: %s", type(e).__name__)
                self._down()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    def _up(self):
        if self.down_alerted:
            self._ops("연결 복구", "Binance WebSocket 이 다시 연결됐습니다. 누락 봉을 REST 로 복구합니다.",
                      f"up|{int(time.time())}")
        self.connected, self.down_since, self.down_alerted = True, None, False

    def _down(self):
        self.connected = False
        self.down_since = self.down_since or time.time()

    async def watchdog(self):
        while True:
            await asyncio.sleep(10)
            await self.q.put(None)  # 주기 틱: WS 메시지를 놓쳐도 시계 기준으로 처리
            d = self.down_since
            if d and not self.down_alerted and time.time() - d > self.cfg.ops.disconnect_alert_after_s:
                self.down_alerted = True
                self._ops("데이터 연결 장애", f"Binance WebSocket 이 {int(time.time() - d)}초째 끊겨 있습니다. "
                          "이 동안 신호가 지연/누락될 수 있습니다.", f"down|{int(d)}")

    async def worker(self):
        while True:
            await self.q.get()
            while not self.q.empty():
                self.q.get_nowait()
            try:
                await asyncio.to_thread(self.process)
            except Exception as e:  # 한 번의 오류로 전체 루프를 죽이지 않는다
                log.exception("process failed: %s", type(e).__name__)

    async def flusher(self):
        while True:
            await asyncio.sleep(3)
            await asyncio.to_thread(self.notifier.flush)

    async def run(self):
        await asyncio.to_thread(self.bootstrap)
        await asyncio.gather(self.ws_loop(), self.worker(), self.watchdog(), self.flusher())
