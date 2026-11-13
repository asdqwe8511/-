"""패턴 B(돌파→재이탈→리테스트) 숏 시나리오. 가격은 숏 세계 기준 실제 좌표."""
import synth
from synth import bar, ramp

A, Z = 19700.0, 18700.0
L = Z + 0.5 * (A - Z)  # 19200


def tail_b():
    t = []
    t += ramp(19000, 19180, 9)
    t += [bar(19185, 19262, 19264, 19183), bar(19262, 19270), bar(19270, 19280)]   # 돌파 + 3봉 연속 종가
    t += [bar(19280, 19190, 19282, 19188)]                                         # 저항 아래 재이탈 종가
    t += [bar(19188, 19165, 19190, 19162)]                                        # 되돌림(리테스트 범위 밖)
    t += [bar(19175, 19168, 19203, 19166)]                                         # 리테스트 거부(하락 확인)
    t += ramp(19168, 18690, 40)                                                    # 목표 0 도달
    t += ramp(18690, 18600, 8)
    t += ramp(18600, 18680, 8)                                                    # 반등 → 피벗 고점
    t += ramp(18680, 18560, 10)
    t += ramp(18560, 18730, 12)                                                   # 후행 SL 체결
    t += ramp(18730, 18740, 6)
    return t


def make(mirror=False, tail=None):
    bars = synth.background(3600) + (tail or tail_b())
    return synth.mirror(bars) if mirror else bars


def install_fake_fit(monkeypatch, start_idx, mirror=False, target=Z):
    from fibo_alert import fib
    t_start = synth.T0 + start_idx * synth.M15

    def fake(view, atr, cfg):
        if int(view["open_time"].iloc[-1]) < t_start:
            return None
        if mirror:
            return synth.fake_fit(A - synth.K, target - synth.K, t_start - 1000)
        return synth.fake_fit(A, target, t_start - 1000)
    monkeypatch.setattr(fib, "auto_find", fake)
