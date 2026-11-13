from __future__ import annotations


def assess(side, entry, sl, target, cfg):
    """실제 가격 좌표 기준 손익비·비용·레버리지 경고. 청산가격은 계산하지 않는다(계좌 정보 없음)."""
    risk = abs(sl - entry)
    reward = abs(entry - target)
    c = cfg.costs
    fee = c.fee_rate_per_side * 2 * entry
    slip = c.slippage_bps_per_side / 1e4 * 2 * entry
    cost = fee + slip
    rr = reward / risk if risk > 0 else 0.0
    rr_net = (reward - cost) / (risk + cost) if risk > 0 else 0.0
    sl_pct = risk / entry * 100
    margin_loss = sl_pct * c.leverage
    if margin_loss >= 100:
        warn = "경고: 이 레버리지에서는 SL 도달 전에 청산될 가능성이 큽니다(근사)."
    elif margin_loss >= 60:
        warn = "주의: SL 도달 시 증거금 대부분을 잃는 수준입니다(근사)."
    else:
        warn = ""
    return {
        "entry": entry, "sl": sl, "target": target, "risk": risk, "reward": reward,
        "rr": rr, "rr_net": rr_net, "sl_pct": sl_pct,
        "fee_roundtrip": fee, "slippage_roundtrip": slip, "cost": cost,
        "leverage": c.leverage, "margin_loss_pct_at_sl": margin_loss, "leverage_warning": warn,
        "liq_note": "실제 청산가격은 계좌·유지증거금 정보가 없어 계산하지 않았습니다.",
    }
