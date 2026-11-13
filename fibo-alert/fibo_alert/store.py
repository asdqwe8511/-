"""SQLite 저장소: 봉, 피팅(동결), 신호 상태, 전이 이력, 알림 outbox."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager

import numpy as np
import pandas as pd

from .util import tf_ms

SCHEMA = """
CREATE TABLE IF NOT EXISTS candles(
  symbol TEXT, tf TEXT, open_time INTEGER,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY(symbol, tf, open_time));
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS fits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT, side TEXT, version INTEGER, source TEXT,
  created_close INTEGER, start_time INTEGER, start_price REAL,
  frozen_json TEXT NOT NULL,
  status TEXT NOT NULL, status_close INTEGER, reached_close INTEGER,
  UNIQUE(symbol, side, version, source));
CREATE TRIGGER IF NOT EXISTS fits_frozen BEFORE UPDATE OF
  frozen_json, start_time, start_price, created_close, side, version ON fits
BEGIN SELECT RAISE(ABORT, 'fit prediction is frozen'); END;
CREATE TABLE IF NOT EXISTS signals(
  key TEXT PRIMARY KEY, symbol TEXT, side TEXT, pattern TEXT,
  fit_version INTEGER, ratio REAL, state TEXT NOT NULL, ctx_json TEXT NOT NULL,
  source TEXT, created_close INTEGER, updated_close INTEGER);
CREATE TABLE IF NOT EXISTS transitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_key TEXT, from_state TEXT, to_state TEXT, bar_close INTEGER, reason TEXT,
  source TEXT, UNIQUE(signal_key, to_state, bar_close));
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE, kind TEXT, signal_key TEXT, bar_close INTEGER,
  payload_json TEXT, status TEXT, attempts INTEGER DEFAULT 0,
  next_try REAL DEFAULT 0, created_ms INTEGER, sent_ms INTEGER, last_error TEXT,
  source TEXT);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, next_try);
"""


class Store:
    def __init__(self, path: str = ":memory:", symbol: str = "BTCUSDT", source: str = "live"):
        self.symbol, self.source = symbol, source
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL") if path != ":memory:" else None
        self.conn.executescript(SCHEMA)
        self._depth = 0

    # ---- 트랜잭션
    @contextmanager
    def tx(self):
        if self._depth:
            self._depth += 1
            try:
                yield
            finally:
                self._depth -= 1
            return
        self.conn.execute("BEGIN IMMEDIATE")
        self._depth = 1
        try:
            yield
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        finally:
            self._depth = 0

    # ---- meta
    def get_meta(self, k, default=None):
        r = self.conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def set_meta(self, k, v):
        self.conn.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, json.dumps(v)))

    # ---- candles
    def upsert_candles(self, tf: str, rows) -> int:
        """rows: (open_time, o, h, l, c, v) — 확정된 봉만 넣을 것."""
        data = [(self.symbol, tf, int(r[0]), *map(float, r[1:6])) for r in rows]
        with self.tx():
            self.conn.executemany("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)", data)
        return len(data)

    def last_open(self, tf: str):
        r = self.conn.execute("SELECT MAX(open_time) FROM candles WHERE symbol=? AND tf=?",
                              (self.symbol, tf)).fetchone()
        return r[0]

    def first_open(self, tf: str):
        r = self.conn.execute("SELECT MIN(open_time) FROM candles WHERE symbol=? AND tf=?",
                              (self.symbol, tf)).fetchone()
        return r[0]

    def load_candles(self, tf: str, end_ms: int, limit: int, start_ms: int | None = None) -> pd.DataFrame:
        """봉 종료시각(open+tf) <= end_ms 인 확정봉만, 오래된 순."""
        last_open = end_ms - tf_ms(tf)
        q = ("SELECT open_time,open,high,low,close,volume FROM candles "
             "WHERE symbol=? AND tf=? AND open_time<=?")
        args = [self.symbol, tf, last_open]
        if start_ms is not None:
            q += " AND open_time>=?"
            args.append(start_ms)
        q += " ORDER BY open_time DESC LIMIT ?"
        args.append(limit)
        rows = self.conn.execute(q, args).fetchall()[::-1]
        arr = np.array(rows, dtype=float).reshape(-1, 6)
        df = pd.DataFrame(arr, columns=["open_time", "open", "high", "low", "close", "volume"])
        df["open_time"] = df["open_time"].astype("int64")
        return df

    # ---- fits
    def next_fit_version(self, side: str) -> int:
        r = self.conn.execute("SELECT MAX(version) FROM fits WHERE symbol=? AND side=? AND source=?",
                              (self.symbol, side, self.source)).fetchone()
        return (r[0] or 0) + 1

    def insert_fit(self, side, version, created_close, start_time, start_price, frozen: dict):
        self.conn.execute(
            "INSERT INTO fits(symbol,side,version,source,created_close,start_time,start_price,"
            "frozen_json,status) VALUES(?,?,?,?,?,?,?,?,'active')",
            (self.symbol, side, version, self.source, created_close, start_time, start_price,
             json.dumps(frozen, default=float)))

    def _fit_row(self, r):
        if not r:
            return None
        cols = ["id", "side", "version", "created_close", "start_time", "start_price",
                "frozen_json", "status", "status_close", "reached_close"]
        d = dict(zip(cols, r))
        d["frozen"] = json.loads(d.pop("frozen_json"))
        return d

    _FIT_SEL = ("SELECT id,side,version,created_close,start_time,start_price,frozen_json,status,"
                "status_close,reached_close FROM fits WHERE symbol=? AND source=? ")

    def active_fit(self, side):
        r = self.conn.execute(self._FIT_SEL + "AND side=? AND status='active' ORDER BY version DESC LIMIT 1",
                              (self.symbol, self.source, side)).fetchone()
        return self._fit_row(r)

    def fit_starts(self, side) -> set[int]:
        return {r[0] for r in self.conn.execute(
            "SELECT start_time FROM fits WHERE symbol=? AND source=? AND side=?",
            (self.symbol, self.source, side))}

    def all_fits(self):
        return [self._fit_row(r) for r in self.conn.execute(
            self._FIT_SEL + "ORDER BY id", (self.symbol, self.source))]

    def set_fit_status(self, fit_id, status, close_ms, reached_close=None):
        self.conn.execute("UPDATE fits SET status=?, status_close=?, reached_close=COALESCE(?,reached_close) "
                          "WHERE id=?", (status, close_ms, reached_close, fit_id))

    # ---- signals
    def save_signal(self, sig, close_ms):
        self.conn.execute(
            "INSERT INTO signals(key,symbol,side,pattern,fit_version,ratio,state,ctx_json,source,"
            "created_close,updated_close) VALUES(?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET state=excluded.state, ctx_json=excluded.ctx_json, "
            "updated_close=excluded.updated_close",
            (sig.key, self.symbol, sig.side, sig.pattern, sig.fit_version, sig.ratio, sig.state,
             json.dumps(sig.ctx, default=float), self.source, close_ms, close_ms))

    def load_signals(self, side=None, states=None):
        from .engine import Sig
        q = ("SELECT key,side,pattern,fit_version,ratio,state,ctx_json FROM signals "
             "WHERE symbol=? AND source=?")
        args = [self.symbol, self.source]
        if side:
            q += " AND side=?"
            args.append(side)
        if states:
            q += " AND state IN (%s)" % ",".join("?" * len(states))
            args += list(states)
        q += " ORDER BY key"
        return [Sig(k, s, p, fv, r, st, json.loads(c)) for k, s, p, fv, r, st, c in self.conn.execute(q, args)]

    def add_transition(self, key, frm, to, bar_close, reason):
        self.conn.execute("INSERT OR IGNORE INTO transitions(signal_key,from_state,to_state,bar_close,"
                          "reason,source) VALUES(?,?,?,?,?,?)", (key, frm, to, bar_close, reason, self.source))

    def transitions(self):
        return self.conn.execute("SELECT signal_key,from_state,to_state,bar_close,reason FROM transitions "
                                 "WHERE source=? ORDER BY id", (self.source,)).fetchall()

    # ---- alerts (outbox)
    def add_alert(self, dedupe_key, kind, signal_key, bar_close, payload, status="pending") -> bool:
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO alerts(dedupe_key,kind,signal_key,bar_close,payload_json,status,"
            "created_ms,source) VALUES(?,?,?,?,?,?,?,?)",
            (dedupe_key, kind, signal_key, bar_close, json.dumps(payload, default=float), status,
             int(time.time() * 1000), self.source))
        return cur.rowcount == 1

    def pending_alerts(self, now_s: float, limit=20):
        rows = self.conn.execute(
            "SELECT id,dedupe_key,kind,payload_json,attempts FROM alerts WHERE status='pending' "
            "AND next_try<=? AND source=? ORDER BY id LIMIT ?", (now_s, self.source, limit)).fetchall()
        return [(i, d, k, json.loads(p), a) for i, d, k, p, a in rows]

    def mark_alert(self, alert_id, status, attempts=None, next_try=None, error=None):
        self.conn.execute(
            "UPDATE alerts SET status=?, attempts=COALESCE(?,attempts), next_try=COALESCE(?,next_try), "
            "last_error=?, sent_ms=CASE WHEN ?='sent' THEN ? ELSE sent_ms END WHERE id=?",
            (status, attempts, next_try, error, status, int(time.time() * 1000), alert_id))

    def alert_keys(self):
        return {r[0] for r in self.conn.execute("SELECT dedupe_key FROM alerts WHERE source=?",
                                                (self.source,))}
