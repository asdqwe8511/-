import zipfile

from fibo_alert.store import Store
from fibo_alert.vision import import_dir

HDR = "open_time,open,high,low,close,volume,close_time,quote_volume,count,tb,tq,ignore\n"


def test_import_skips_header_and_reports_gaps(tmp_path):
    rows = [f"{t},1,2,0.5,1.5,10,{t+899999},0,0,0,0,0\n" for t in (0, 900000, 2700000)]  # 한 봉 빠짐
    with zipfile.ZipFile(tmp_path / "BTCUSDT-15m-2026-10.zip", "w") as z:
        z.writestr("BTCUSDT-15m-2026-10.csv", HDR + "".join(rows))
    st = Store(":memory:")
    n, gaps = import_dir(st, str(tmp_path))
    assert n == {"15m": 3} and gaps == {"15m": 1}
