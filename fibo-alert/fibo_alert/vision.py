"""data.binance.vision 월별 klines zip(USDⓈ-M 선물) → Store. 확정된 과거 봉이라 미확정 봉 문제가 없다."""
from __future__ import annotations

import csv
import glob
import io
import os
import re
import zipfile

from .util import tf_ms


def read_zip(path):
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.endswith(".csv"):
                continue
            for row in csv.reader(io.TextIOWrapper(z.open(name), encoding="utf-8")):
                if row and row[0].isdigit():  # 헤더 행 건너뜀
                    yield int(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5])


def import_dir(store, directory):
    """BTCUSDT-<tf>-YYYY-MM.zip 파일들을 적재하고 tf 별 봉 수를 돌려준다. 빈 봉(gap)은 보고만 한다."""
    out = {}
    for path in sorted(glob.glob(os.path.join(directory, "*-*-????-??.zip"))):
        tf = re.match(r".*?-(\d+[mh])-\d{4}-\d{2}\.zip$", path).group(1)
        rows = list(read_zip(path))
        out[tf] = out.get(tf, 0) + store.upsert_candles(tf, rows)
    gaps = {}
    for tf in out:
        m = tf_ms(tf)
        ts = [r[0] for r in store.conn.execute("SELECT open_time FROM candles WHERE symbol=? AND tf=? "
                                               "ORDER BY open_time", (store.symbol, tf))]
        gaps[tf] = sum(1 for a, b in zip(ts, ts[1:]) if b - a != m)
    return out, gaps
