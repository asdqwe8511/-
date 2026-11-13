"""신호 엔진. 확정된 15m 봉이 닫힐 때마다 step() 한 번.

- 입력은 종료시각 <= close_ms 인 확정봉뿐이다(미래 봉·미확정 봉 사용 불가).
- 롱은 가격 부호를 뒤집은 '숏 세계'에서 같은 코드로 처리하고, 알림 payload 에서만 실제 가격으로 되돌린다.
- ctx(JSON) 안의 가격은 숏 세계 좌표다. 알림/결과(result)는 실제 좌표.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from . import fib, risk, trend as trendmod
from .indicators import atr as atr_fn, pivot_high_pos
from .states import *  # noqa: F401,F403
from .states import ALLOWED, POSITION_STATES, PRE_ENTRY, TERMINAL, check_transition
from .util import DataError, IndicatorError, fmt_utc, tf_ms

SIDES = ("SHORT", "LONG")


def sign(side):
    return 1.0 if side == "SHORT" else -1.0


def view(df, side):
    if side == "SHORT":
        return df
    v = df.copy()
    v["open"], v["close"], v["high"], v["low"] = -df["open"], -df["close"], -df["low"], -df["high"]
    return v


@dataclass
class Sig:
    key: str
    side: str
    pattern: str
    fit_version: int
    ratio: float
    state: str
    ctx: dict


@dataclass
class StepResult:
    status: str  # OK | DATA_ERROR
    detail: str = ""


class Bars:
    """한 봉 시점의 숏 세계 뷰."""

    def __init__(self, v, atr_series, close_ms, sg, trend, tf):
        self.v, self.sg, self.trend, self.close_ms, self.tf = v, sg, trend, close_ms, tf
        self.t = v["open_time"].values
        self.o, self.h, self.l, self.c = (v[k].values for k in ("open", "high", "low", "close"))
        self.a = float(atr_series.iloc[-1])
        self.time = int(self.t[-1])
        self.open, self.high, self.low, self.close = (float(x[-1]) for x in (self.o, self.h, self.l, self.c))
        self.piv, self.piv_pos = [], []

    def pos_of(self, t):
        return int(np.searchsorted(self.t, t))

    def body_ratio(self):
        rng = self.high - self.low
        return abs(self.close - self.open) / rng if rng > 0 else 0.0


class Engine:
    def __init__(self, cfg, store):
        self.cfg, self.st = cfg, store
        self.tfm = tf_ms(cfg.trigger_tf)

    # ------------------------------------------------------------------ 데이터
    def _frames(self, close_ms):
        need = ["15m", "1h"] + (["4h"] if self.cfg.trend.use_4h_filter else [])
        frames = {}
        for tf in need:
            m = tf_ms(tf)
            df = self.st.load_candles(tf, close_ms, self.cfg.history_bars[tf])
            expected = (close_ms // m) * m - m
            if df.empty or int(df["open_time"].iloc[-1]) != expected:
                last = fmt_utc(int(df["open_time"].iloc[-1]) + m) if len(df) else "none"
                raise DataError(f"{tf}: latest closed bar missing (have up to {last}, "
                                f"need close {fmt_utc(expected + m)})")
            k = min(len(df), self.cfg.gap_check_bars)
            d = np.diff(df["open_time"].values[-k:])
            if len(d) and not (d == m).all():
                raise DataError(f"{tf}: gap in last {k} bars")
            if not np.isfinite(df[["open", "high", "low", "close"]].values).all():
                raise IndicatorError(f"{tf}: non-finite OHLC")
            frames[tf] = df
        return frames

    # ------------------------------------------------------------------ step
    def step(self, close_ms, now_ms=None) -> StepResult:
        self.now_ms = now_ms
        try:
            frames = self._frames(close_ms)
            tr = trendmod.decide(frames, self.cfg)
            base = frames[self.cfg.trigger_tf]
            for side in SIDES:  # 미리 계산: 오류가 나면 아무것도 쓰기 전에 중단
                self._bars(base, side, close_ms, tr)
        except (DataError, IndicatorError) as e:
            self.st.set_meta("engine_status", {"state": "DATA_ERROR", "close": close_ms, "detail": str(e)})
            return StepResult("DATA_ERROR", str(e))
        with self.st.tx():
            self.trend = tr
            for side in SIDES:
                self._step_side(side, self._bars(base, side, close_ms, tr))
            self.st.set_meta("last_close", close_ms)
            self.st.set_meta("engine_status", {"state": "OK", "close": close_ms, "detail": ""})
            self.st.set_meta("last_trend", {"direction": tr.direction, "reasons": tr.reasons,
                                            "close": close_ms})
        return StepResult("OK")

    def _bars(self, base, side, close_ms, tr):
        v = view(base, side)
        a = atr_fn(v, self.cfg.noise.atr_period)
        if not np.isfinite(a.iloc[-1]) or a.iloc[-1] <= 0:
            raise IndicatorError("ATR invalid")
        b = Bars(v, a, close_ms, sign(side), tr, self.cfg.trigger_tf)
        lr = self.cfg.noise.pivot_lr
        pp = pivot_high_pos(b.h, lr)
        b.piv = [(int(b.t[p]), float(b.h[p])) for p in pp]
        b.piv_pos = pp
        return b

    # ------------------------------------------------------------------ 이벤트
    def _emit(self, kind, dedupe, sig_key, b, payload):
        status = "pending"
        if self.st.source == "replay":
            status = "replay"
        elif self.now_ms is not None and b.close_ms < self.now_ms - self.cfg.alerts.stale_alert_minutes * 60_000:
            status = "suppressed_stale"
        payload = dict(payload, kind=kind, symbol=self.cfg.symbol, bar_close=b.close_ms, virtual=True)
        self.st.add_alert(dedupe, kind, sig_key, b.close_ms, payload, status)

    def _move(self, sig, to, b, reason, notify=None, extra=None):
        check_transition(sig.state, to)
        self.st.add_transition(sig.key, sig.state, to, b.close_ms, reason)
        sig.state = to
        if notify:
            self._emit("INVALID", f"{sig.key}|INVALID", sig.key, b,
                       dict(self._base(sig, b), reason=reason, new_state=to, **(extra or {})))

    def _base(self, sig, b):
        return {"side": sig.side, "pattern": sig.pattern, "ratio": sig.ratio, "signal_key": sig.key,
                "trend": b.trend.summary(), "timeframe": self.cfg.trigger_tf}

    def _real(self, b, x):
        return b.sg * x

    # ------------------------------------------------------------------ 사이드별 처리
    def _step_side(self, side, b):
        sigs = {s.key: s for s in self.st.load_signals(side)}
        allowed = b.trend.direction == side

        # 1) 열린 가상 포지션 관리
        for s in sigs.values():
            if s.state in POSITION_STATES:
                self._manage_position(s, b)
                self.st.save_signal(s, b.close_ms)

        # 2) 피팅 수명 주기
        fit = self.st.active_fit(side)
        if fit:
            fit = self._fit_lifecycle(fit, sigs, b)
        if fit is None and allowed:
            fit = self._new_fit(side, b, sigs)

        # 3) 진입 전 신호 갱신
        if fit:
            for s in sorted(sigs.values(), key=lambda x: x.key):
                if s.fit_version != fit["version"] or s.state not in PRE_ENTRY:
                    continue
                self._advance(s, fit, b, allowed, sigs)
                self.st.save_signal(s, b.close_ms)

    # ---- 피팅
    def _fit_lifecycle(self, fit, sigs, b):
        A, Z = fit["frozen"]["start_price"], fit["frozen"]["target"]
        status = reason = None
        if b.high > A:
            status, reason = "invalidated", "start_exceeded"
        elif b.low <= Z:
            status, reason = "reached", "target_reached_before_entry"
        elif (b.close_ms - fit["created_close"]) / self.tfm > self.cfg.fib.fit_max_bars:
            status, reason = "expired", "fit_expired"
        if status is None:
            return fit
        self.st.set_fit_status(fit["id"], status, b.close_ms, b.close_ms if status == "reached" else None)
        for s in sigs.values():
            if s.fit_version == fit["version"] and s.state in PRE_ENTRY:
                notify = s.state != WAITING and status != "reached"
                self._move(s, TIMEOUT if status == "expired" else INVALIDATED, b, reason, notify=notify)
                self.st.save_signal(s, b.close_ms)
        return None

    def _new_fit(self, side, b, sigs):
        cfg = self.cfg
        known = self.st.fit_starts(side)
        f = None
        if cfg.fib.start_mode == "manual":
            m = cfg.fib.manual_start
            if m.side != side or not m.time:
                return None
            from .util import parse_utc
            st_time = parse_utc(m.time) if isinstance(m.time, str) else int(m.time)
            if st_time in known:
                return None
            f = fib.manual_find(b.v, st_time, m.price if m.price is None else sign(side) * m.price,
                                b.a, cfg)
        else:
            f = fib.auto_find(b.v, b.a, cfg)
            if f and f["start_time"] in known:
                return None
        if not f:
            return None
        fit = self.create_fit(side, f, b)
        sigs.clear()
        sigs.update({x.key: x for x in self.st.load_signals(side)})
        return fit

    def create_fit(self, side, f, b):
        """동결된 피팅 저장 + 레벨별 신호(A/B) 생성. 이후 목표는 수정되지 않는다(DB 트리거로 강제)."""
        ver = self.st.next_fit_version(side)
        frozen = dict(f, side=side, version=ver, created_close=b.close_ms, world="short",
                      sign=b.sg, config={"fib": self.cfg.fib.to_dict(), "noise": self.cfg.noise.to_dict()},
                      real_target=b.sg * f["target"], real_start_price=b.sg * f["start_price"],
                      real_zone=sorted([b.sg * f["zone_lo"], b.sg * f["zone_hi"]]))
        self.st.insert_fit(side, ver, b.close_ms, f["start_time"], f["start_price"], frozen)
        fit = self.st.active_fit(side)
        A, Z = f["start_price"], f["target"]
        for r in self.cfg.fib.entry_levels:
            L = fib.level_price(Z, A, r)
            for pat in ("A", "B"):
                key = f"{self.cfg.symbol}|{side}|v{ver}|{pat}|{r}"
                s = Sig(key, side, pat, ver, r, WAITING, {"level": L, "armed": False})
                self.st.save_signal(s, b.close_ms)
        return fit

    # ---- 진입 전 상태 머신
    def _advance(self, s, fit, b, allowed, sigs):
        cfg, n, e = self.cfg, self.cfg.noise, self.cfg.entry
        ctx, L, a = s.ctx, s.ctx["level"], b.a
        # 추세 충돌: 관심 구간 이후 단계에서 허용 방향이 사라지면 무효화
        if s.state in (WATCHING, BREAKOUT_CONFIRMED, RETEST_PENDING) and not allowed:
            reason = "추세 충돌: " + ("; ".join(b.trend.reasons) or f"허용 방향={b.trend.direction}")
            self._move(s, INVALIDATED, b, reason, notify=True)
            return
        for _ in range(3):  # 같은 봉에서 연쇄 전이 허용(WAITING→WATCHING→…)
            before = s.state
            if s.state == WAITING:
                self._waiting(s, b, allowed, fit)
            elif s.state == WATCHING:
                (self._a_watching if s.pattern == "A" else self._b_watching)(s, b, fit, sigs)
            elif s.state == BREAKOUT_CONFIRMED:
                self._b_breakout(s, b)
            elif s.state == RETEST_PENDING:
                (self._a_pending if s.pattern == "A" else self._b_pending)(s, b, fit, sigs, allowed)
            if s.state == before or s.state not in PRE_ENTRY:
                break

    def _waiting(self, s, b, allowed, fit):
        L, a = s.ctx["level"], b.a
        if b.close < L:
            s.ctx["armed"] = True
        if not (s.ctx.get("armed") and allowed):
            return
        if b.high >= L - self.cfg.entry.approach_atr * a:
            s.ctx["watch_time"] = b.time
            s.ctx["watch_close"] = b.close_ms
            self._move(s, WATCHING, b, "fib 구간 접근")
            fz = fit["frozen"]
            self._emit("APPROACH", f"{self.cfg.symbol}|{s.side}|v{s.fit_version}|{s.ratio}|APPROACH", s.key, b,
                       dict(self._base(s, b), level=self._real(b, L), ratio=s.ratio,
                            zone=self.cfg.entry.zone_atr * a,
                            price=self._real(b, b.close), target=fz["real_target"],
                            target_zone=fz["real_zone"], n_matches=fz["n_matches"],
                            fit_version=s.fit_version, atr=a))

    def _watch_timeout(self, s, b):
        if (b.close_ms - s.ctx["watch_close"]) / self.tfm > self.cfg.entry.watch_max_bars:
            self._move(s, TIMEOUT, b, "관심 구간 대기시간 초과", notify=True)
            return True
        return False

    # 패턴 A: 저항 돌파 실패(더블탑 / 낮은 반등 고점) → 넥라인 이탈
    def _a_watching(self, s, b, fit, sigs):
        e, L, a, ctx = self.cfg.entry, s.ctx["level"], b.a, s.ctx
        zone = e.zone_atr * a
        if b.close > L + zone:
            self._move(s, INVALIDATED, b, "저항 상향 돌파(패턴 B 로 이관)", notify=False)
            return
        if self._watch_timeout(s, b):
            return
        tol = e.double_top_tol_atr * a
        P = [(t, p) for t, p in b.piv if t >= ctx["watch_time"] and L - zone <= p <= L + zone]
        if len(P) < 1:
            return
        # 이미 사용한 피벗 쌍은 건너뛴다
        for i in range(len(P) - 1, -1, -1):
            h1 = P[i]
            for h2 in [x for x in b.piv if x[0] > h1[0]]:
                if h2[0] <= ctx.get("last_h2", 0):
                    continue
                d = h2[1] - h1[1]
                if d <= tol and d >= -e.lower_high_max_atr * a:
                    shape = "double_top" if abs(d) <= tol else "lower_high"
                    p1, p2 = b.pos_of(h1[0]), b.pos_of(h2[0])
                    neck = float(b.l[p1:p2 + 1].min())
                    ctx.update(h1=h1[1], h1_time=h1[0], h2=h2[1], h2_time=h2[0], neck=neck, shape=shape,
                               last_h2=h2[0], retest_high=max(h1[1], h2[1]),
                               deadline=b.close_ms + self.cfg.noise.retest_max_bars * self.tfm)
                    self._move(s, RETEST_PENDING, b, f"{shape} 형성, 넥라인 {neck:.1f} 이탈 대기")
                    return

    def _a_pending(self, s, b, fit, sigs, allowed):
        ctx, a = s.ctx, b.a
        tol = self.cfg.noise.retest_atr * a
        if b.close > ctx["retest_high"] + tol:
            self._move(s, INVALIDATED, b, "레벨 회복(반등 고점 상향 돌파)", notify=True)
            return
        if b.close < ctx["neck"] and b.close < b.open and b.time > ctx["h2_time"]:
            self._enter(s, b, fit, sigs, ctx["retest_high"], allowed,
                        f"저항 돌파 실패({'더블탑' if ctx['shape'] == 'double_top' else '낮은 반등 고점'}) 후 넥라인 이탈")
            return
        if b.close_ms >= ctx["deadline"]:
            self._move(s, TIMEOUT, b, "넥라인 이탈 대기시간 초과", notify=True)

    # 패턴 B: 돌파 → 재이탈 → 리테스트
    def _b_watching(self, s, b, fit, sigs):
        n, ctx, L, a = self.cfg.noise, s.ctx, s.ctx["level"], b.a
        if self._watch_timeout(s, b):
            return
        bo = ctx.get("bo")
        if bo is None:
            if (b.close >= L + n.breakout_atr * a and b.close > b.open
                    and b.body_ratio() >= n.breakout_body_ratio):
                ctx["bo"] = bo = {"start": b.time, "n": 1}
            else:
                return
        elif b.time > bo["start"]:
            if b.close > L:
                bo["n"] += 1
            else:
                ctx["bo"] = None  # 3봉 확인 전에 실패 → 돌파 아님
                return
        if bo["n"] >= n.breakout_confirm_closes:
            ctx["bo_confirm_close"] = b.close_ms
            self._move(s, BREAKOUT_CONFIRMED, b, f"{bo['n']}봉 연속 종가로 돌파 확인")

    def _b_breakout(self, s, b):
        ctx, L = s.ctx, s.ctx["level"]
        if b.close < L:
            ctx.update(reloss_time=b.time, touched=False, retest_high=b.high,
                       deadline=b.close_ms + self.cfg.noise.retest_max_bars * self.tfm)
            self._move(s, RETEST_PENDING, b, "저항 아래로 재이탈 종가")
            return
        if (b.close_ms - ctx["bo_confirm_close"]) / self.tfm > self.cfg.entry.breakout_wait_bars:
            self._move(s, TIMEOUT, b, "재이탈 대기시간 초과", notify=True)

    def _b_pending(self, s, b, fit, sigs, allowed):
        ctx, L, a = s.ctx, s.ctx["level"], b.a
        tol = self.cfg.noise.retest_atr * a
        if b.time > ctx["reloss_time"]:
            if b.close > L + tol:
                self._move(s, INVALIDATED, b, "레벨 회복(리테스트 허용범위 초과 종가)", notify=True)
                return
            if b.high >= L - tol:
                if not ctx["touched"]:
                    ctx["touched"], ctx["retest_high"] = True, b.high
                else:
                    ctx["retest_high"] = max(ctx["retest_high"], b.high)
                if b.close < L and b.close < b.open:
                    self._enter(s, b, fit, sigs, ctx["retest_high"], allowed,
                                "저항 돌파 후 재이탈 · 리테스트 거부(하락 확인)")
                    return
        if b.close_ms >= ctx["deadline"]:
            self._move(s, TIMEOUT, b, f"리테스트 대기 {self.cfg.noise.retest_max_bars}봉 초과", notify=True)

    # ---- 진입 후보
    def _enter(self, s, b, fit, sigs, retest_high, allowed, why):
        cfg, a = self.cfg, b.a
        fz = fit["frozen"]
        entry = b.close
        sl = retest_high + cfg.noise.sl_buffer_atr * a
        target = fz["target"]
        ra = risk.assess(s.side, b.sg * entry, b.sg * sl, b.sg * target, cfg)
        reason = None
        if not allowed:
            reason = "trend_not_allowed"
        elif sl <= entry or entry <= target:
            reason = "invalid_geometry"
        elif ra["rr"] < cfg.entry.min_rr:
            reason = f"rr_below_min({ra['rr']:.2f}<{cfg.entry.min_rr})"
        elif any(x.state in POSITION_STATES for x in sigs.values() if x.side == s.side):
            reason = "position_already_open"
        if reason:
            self._move(s, INVALIDATED, b, reason, notify=cfg.entry.notify_rr_reject,
                       extra={"rr": ra["rr"]})
            return
        s.ctx["position"] = {
            "entry": entry, "sl": sl, "sl0": sl, "target": target, "risk0": sl - entry,
            "entry_time": b.time, "entry_close": b.close_ms, "atr": a,
            "best_low": entry, "worst_high": entry, "last_trail_pivot": 0, "ra": ra}
        self._move(s, ENTRY_CANDIDATE, b, why)
        self._emit("ENTRY", f"{s.key}|ENTRY", s.key, b, dict(
            self._base(s, b), entry=b.sg * entry, sl=b.sg * sl, target=b.sg * target,
            target_zone=fz["real_zone"], n_matches=fz["n_matches"], fit_version=s.fit_version,
            fit_mean_err_atr=fz["mean_err_atr"], pattern_name="저항 돌파 실패" if s.pattern == "A"
            else "돌파 후 재이탈·리테스트", why=why, risk=ra, atr=a, level=b.sg * s.ctx["level"],
            ema=b.trend.summary()))
        # 같은 사이드의 나머지 진입 전 신호는 조용히 정리(중복 방지)
        for o in sigs.values():
            if o is not s and o.state in PRE_ENTRY:
                self._move(o, INVALIDATED, b, "다른 신호가 진입 후보로 확정됨", notify=False)
                self.st.save_signal(o, b.close_ms)

    # ---- 가상 포지션
    def _manage_position(self, s, b):
        p, cfg = s.ctx["position"], self.cfg
        if b.time <= p["entry_time"]:
            return
        p["best_low"] = min(p["best_low"], b.low)
        p["worst_high"] = max(p["worst_high"], b.high)
        if s.state in (TARGET_REACHED, TRAILING):
            p["post_low"] = min(p["post_low"], b.low)
        if b.high >= p["sl"]:  # SL 우선(같은 봉에서 목표·SL 동시 터치 시 보수적으로 SL)
            exit_ = max(b.open, p["sl"])
            self._close(s, b, exit_, "STOP_LOSS" if s.state == ENTRY_CANDIDATE else "TRAILING_STOP")
            return
        if s.state == ENTRY_CANDIDATE and b.low <= p["target"]:
            p.update(target_time=b.time, target_close=b.close_ms, post_low=b.low,
                     last_trail_pivot=b.time)
            self._move(s, TARGET_REACHED, b, "피보나치 0 도달")
            cand = [x for x in b.piv if x[0] > p["entry_time"]]
            prot = min([p["entry"]] + [x[1] + cfg.noise.sl_buffer_atr * b.a for x in cand[-1:]])
            prot = min(prot, p["sl"])
            self._emit("TARGET", f"{s.key}|TARGET", s.key, b, dict(
                self._base(s, b), target=b.sg * p["target"], entry=b.sg * p["entry"], sl=b.sg * p["sl"],
                bars=(b.close_ms - p["entry_close"]) // self.tfm, protect_candidate=b.sg * prot,
                price=b.sg * b.close))
            return
        if s.state in (TARGET_REACHED, TRAILING):
            for t, ph in b.piv:
                if t <= p["last_trail_pivot"]:
                    continue
                p["last_trail_pivot"] = t
                cand = ph + cfg.noise.sl_buffer_atr * b.a
                if cand < p["sl"]:  # 유리한 방향으로만 이동(되돌리지 않음)
                    old, p["sl"] = p["sl"], cand
                    if s.state == TARGET_REACHED:
                        self._move(s, TRAILING, b, "확정 스윙으로 후행 SL 갱신")
                    self._emit("TRAIL", f"{s.key}|TRAIL|{t}", s.key, b, dict(
                        self._base(s, b), new_sl=b.sg * cand, old_sl=b.sg * old, pivot=b.sg * ph,
                        pivot_time=t, price=b.sg * b.close))
        if (b.close_ms - p["entry_close"]) / self.tfm > cfg.entry.max_position_bars:
            self._close(s, b, b.close, "MAX_HOLD")

    def _close(self, s, b, exit_, outcome):
        p, cfg = s.ctx["position"], self.cfg
        r0 = p["risk0"]
        reached = "target_time" in p
        cost = p["ra"]["cost"]
        res = {
            "outcome": outcome, "reached_target": reached,
            "entry": b.sg * p["entry"], "exit": b.sg * exit_, "sl0": b.sg * p["sl0"],
            "target": b.sg * p["target"], "risk0": r0,
            "R_gross": (p["entry"] - exit_) / r0, "R_net": (p["entry"] - exit_ - cost) / r0,
            "cost_R": cost / r0,
            "mfe_R": (p["entry"] - p["best_low"]) / r0, "mae_R": (p["worst_high"] - p["entry"]) / r0,
            "bars_held": (b.close_ms - p["entry_close"]) // self.tfm,
            "bars_to_target": ((p["target_close"] - p["entry_close"]) // self.tfm) if reached else None,
            "ext_after_target_R": ((p["target"] - p["post_low"]) / r0) if reached else None,
            "ext_after_target_atr": ((p["target"] - p["post_low"]) / p["atr"]) if reached else None,
            "entry_close": p["entry_close"], "close": b.close_ms, "side": s.side,
            "rr_planned": p["ra"]["rr"], "pattern": s.pattern,
        }
        s.ctx["result"] = res
        self._move(s, CLOSED, b, outcome)
        if cfg.alerts.notify_virtual_close:
            self._emit("CLOSE", f"{s.key}|CLOSE", s.key, b, dict(self._base(s, b), result=res))
