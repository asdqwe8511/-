from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from .config import load_config
from .store import Store


def main(argv=None):
    ap = argparse.ArgumentParser(prog="fibo_alert")
    ap.add_argument("cmd", choices=["run", "backfill", "replay", "backtest", "verify", "test-webhook", "status", "import-vision"])
    ap.add_argument("-c", "--config", default="config.yaml")
    ap.add_argument("--bars", type=int, default=None, help="backfill: 15m 기준 가져올 개수 override")
    ap.add_argument("--dir", default=None, help="import-vision: zip 폴더")
    ap.add_argument("--db", default=None, help="DB 경로 override")
    a = ap.parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = load_config(a.config)
    path = a.db or cfg.db_path
    if path != ":memory:":
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    st = Store(path, cfg.symbol, "live")

    if a.cmd == "backfill":
        from .binance import BinanceRest
        r = BinanceRest()
        for tf in ("15m", "1h", "4h"):
            n = r.backfill(st, cfg.symbol, tf, bars=(a.bars if a.bars and tf == "15m" else cfg.history_bars[tf]))
            print(tf, n)
    elif a.cmd == "import-vision":
        from .vision import import_dir
        n, gaps = import_dir(st, a.dir)
        print("imported", n, "gaps", gaps)
    elif a.cmd == "run":
        from .live import Runner
        from .notifier import DiscordNotifier, webhook_from_env
        url = webhook_from_env()
        if not url:
            sys.exit("DISCORD_WEBHOOK_URL 환경변수가 필요합니다.")
        asyncio.run(Runner(cfg, st, DiscordNotifier(url, st, cfg)).run())
    elif a.cmd in ("replay", "backtest"):
        from .replay import run_replay
        from . import report
        rep, errs = run_replay(st, cfg)
        if errs:
            print(f"[경고] 데이터 오류로 처리하지 못한 봉 {len(errs)}개 (첫 건: {errs[0]})", file=sys.stderr)
        d = report.build(rep, cfg)
        print(report.render(d))
    elif a.cmd == "verify":
        from .replay import verify
        import json
        v = verify(st, cfg)
        print(json.dumps(v, ensure_ascii=False, indent=2, default=str))
        sys.exit(0 if v["ok"] else 1)
    elif a.cmd == "test-webhook":
        from .notifier import DiscordNotifier, webhook_from_env
        url = webhook_from_env()
        if not url:
            sys.exit("DISCORD_WEBHOOK_URL 환경변수가 필요합니다.")
        from .util import now_ms
        st.add_alert(f"OPS|test|{now_ms()}", "OPS", None, now_ms(), {
            "kind": "OPS", "title": "웹훅 테스트", "detail": "연결 확인용 메시지입니다.",
            "bar_close": now_ms(), "virtual": False, "symbol": cfg.symbol})
        print("sent:", DiscordNotifier(url, st, cfg).flush())
    elif a.cmd == "status":
        import json
        print(json.dumps({"engine": st.get_meta("engine_status"), "last_close": st.get_meta("last_close"),
                          "trend": st.get_meta("last_trend"),
                          "alerts": dict(st.conn.execute("SELECT status,COUNT(*) FROM alerts GROUP BY status").fetchall())},
                         ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
