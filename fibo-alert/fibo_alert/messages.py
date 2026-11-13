"""Discord embed 생성. payload(JSON) → embed dict. 모든 가격은 실제 좌표."""
from __future__ import annotations

from .util import fmt_local, fmt_price as P

FOOT = "분석·알림 전용 · 가상 포지션(실제 주문/계좌 아님) · 검증 전 시스템"
RED, GREEN, GREY, AMBER, BLUE = 0xE74C3C, 0x2ECC71, 0x95A5A6, 0xF1C40F, 0x3498DB


def _ema(trend):
    return " / ".join(f"{t['tf']} {'아래' if t['pos']=='below' else '위'}·기울기 {t['slope_pct']:+.2f}%"
                      for t in trend) or "-"


def _title(p, label):
    return f"{p['symbol']} {p.get('timeframe','15m')} · {p['side']} · {label}"


def build(kind: str, p: dict, tz: str = "Asia/Seoul") -> dict:
    side_color = RED if p.get("side") == "SHORT" else GREEN
    t = fmt_local(p["bar_close"], tz)
    f = []
    if kind == "APPROACH":
        title, color = _title(p, "관심 구간 접근"), AMBER
        f = [("피보 레벨", f"{p['ratio']} → {P(p['level'])}"), ("현재가", P(p["price"])),
             ("역산 목표 0 (예측 시점 고정)", f"{P(p['target'])} (구간 {P(p['target_zone'][0])}~{P(p['target_zone'][1])})"),
             ("피팅 매칭", f"{p['n_matches']}개 · 피팅 v{p['fit_version']}"),
             ("EMA200", _ema(p["trend"]))]
        desc = "추세 방향과 일치하는 저항/지지 구간에 접근했습니다. 진입 신호가 아닙니다."
    elif kind == "ENTRY":
        r = p["risk"]
        title, color = _title(p, "진입 후보 확정"), side_color
        f = [("신호 발생(확정봉 종료)", t), ("진입 후보 가격", P(p["entry"])),
             ("구조적 SL", f"{P(p['sl'])} (손절폭 {r['sl_pct']:.2f}% / {P(r['risk'])})"),
             ("역산 목표 0", f"{P(p['target'])} (구간 {P(p['target_zone'][0])}~{P(p['target_zone'][1])})"),
             ("손익비", f"1:{r['rr']:.2f} (비용 반영 1:{r['rr_net']:.2f})"),
             ("비용(왕복)", f"수수료 {P(r['fee_roundtrip'])} + 슬리피지 {P(r['slippage_roundtrip'])}"),
             ("EMA200 방향", _ema(p["trend"])),
             ("피팅", f"매칭 {p['n_matches']}개 · 평균오차 {p['fit_mean_err_atr']:.2f} ATR · v{p['fit_version']}"),
             ("신호 유형", f"패턴 {p['pattern']} — {p['pattern_name']} (레벨 {p['ratio']})"),
             ("진입 근거", p["why"]),
             (f"레버리지 {r['leverage']}x", f"SL 도달 시 증거금 약 {r['margin_loss_pct_at_sl']:.0f}% 손실(근사, 비용 제외). "
              + (r["leverage_warning"] + " " if r["leverage_warning"] else "") + r["liq_note"])]
        desc = "모든 필터·리테스트 조건 충족. 거래 여부는 직접 판단하세요. 포지션 크기는 자동 확대되지 않습니다."
    elif kind == "TARGET":
        title, color = _title(p, "피보나치 0 도달"), BLUE
        f = [("고정 목표 0", P(p["target"])), ("진입 후보가", P(p["entry"])), ("소요", f"{p['bars']}봉"),
             ("현재 SL(가상)", P(p["sl"])), ("수익 보호 SL 후보", P(p["protect_candidate"]))]
        desc = "예측 시점에 고정된 목표에 도달했습니다. 이후 확정 스윙에 따라 후행 SL 후보를 알립니다."
    elif kind == "TRAIL":
        title, color = _title(p, "후행 SL 변경 후보"), BLUE
        f = [("새 SL 후보", P(p["new_sl"])), ("이전 SL", P(p["old_sl"])),
             ("기준 스윙", f"{P(p['pivot'])} @ {fmt_local(p['pivot_time'], tz)}")]
        desc = "확정된 새 스윙 기준 후보입니다. 불리한 방향으로는 되돌리지 않습니다."
    elif kind == "INVALID":
        title, color = _title(p, f"신호 무효화 ({p['new_state']})"), GREY
        f = [("레벨", f"{p['ratio']}"), ("사유", p["reason"])]
        desc = "이 신호는 더 이상 유효하지 않습니다."
    elif kind == "CLOSE":
        r = p["result"]
        title, color = _title(p, f"가상 거래 종료 ({r['outcome']})"), GREY
        f = [("진입→종료", f"{P(r['entry'])} → {P(r['exit'])}"), ("가상 R", f"{r['R_gross']:+.2f}R (비용 후 {r['R_net']:+.2f}R)"),
             ("MFE/MAE", f"{r['mfe_R']:.2f}R / {r['mae_R']:.2f}R"), ("보유", f"{r['bars_held']}봉")]
        desc = "알림용 가상 포지션이 종료됐습니다. 실제 체결 여부와 무관합니다."
    elif kind == "OPS":
        title, color = f"[운영] {p['title']}", AMBER
        f = [("내용", p["detail"])]
        desc = ""
    else:
        raise ValueError(kind)
    embed = {"title": title, "description": desc, "color": color,
             "fields": [{"name": n, "value": str(v)[:1000], "inline": False} for n, v in f],
             "footer": {"text": FOOT}}
    if kind != "OPS":
        embed["fields"].insert(0, {"name": "봉 종료(UTC 기준 · 표시 KST)", "value": t, "inline": False}) \
            if kind != "ENTRY" else None
    return embed
