import numpy as np
import pandas as pd
import pytest

from promoter_tracker import patterns


def path(*knots, leg=15):
    """A price series that moves linearly between the given levels, `leg` bars each."""
    pts = [np.linspace(a, b, leg, endpoint=False) for a, b in zip(knots, knots[1:], strict=False)]
    close = np.r_[np.concatenate(pts), knots[-1]]
    idx = pd.bdate_range("2024-01-01", periods=len(close))
    return pd.DataFrame({"close": close, "volume": 1000.0}, index=idx)


def found(bars, pattern, **kw):
    return [d for d in patterns.detect("X", bars, **kw) if d.pattern == pattern]


def test_head_and_shoulders_and_its_mirror():
    hs = path(100, 120, 105, 132, 105, 120, 90, 85)
    [d] = found(hs, "head_shoulders")
    assert d.direction == "bear" and d.level == pytest.approx(105)
    assert d.target == pytest.approx(105 - (132 - 105))  # measured move from the neckline
    assert d.invalidation == pytest.approx(120)  # back above the right shoulder = failed
    assert [p["label"] for p in d.points][::2] == ["Left shoulder", "Head", "Right shoulder"]
    assert 0 < d.quality <= 100 and "rose 20% into the pattern" in d.quality_reasons
    assert found(path(130, 110, 125, 98, 125, 110, 140, 145), "inverse_head_shoulders")


def test_reversals_need_a_trend_to_reverse():
    # The same shape after a fall into it is not a head and shoulders top.
    assert not found(path(140, 120, 105, 132, 105, 120, 90, 85), "head_shoulders")


def test_double_top_and_bottom():
    assert found(path(100, 130, 115, 131, 100, 95), "double_top")
    assert found(path(130, 100, 115, 99, 130, 135), "double_bottom")


def test_cup_and_handle():
    [d] = found(path(80, 120, 120, 90, 90, 119, 112, 128, 130, leg=20), "cup_handle")
    assert d.direction == "bull" and d.level == pytest.approx(120)


def test_triangles_need_three_touches_and_a_narrowing_range():
    assert found(path(90, 120, 100, 120.5, 108, 120.8, 114, 135), "ascending_triangle")
    assert found(path(140, 100, 120, 99.5, 112, 99.2, 106, 85), "descending_triangle")
    # Flat top but the lows don't rise: not an ascending triangle.
    assert not found(path(90, 120, 100, 120.5, 100, 120.8, 100, 135), "ascending_triangle")


def test_no_detection_before_the_breakout_happens():
    full = path(100, 120, 105, 132, 105, 120, 90, 85)
    [d] = found(full, "head_shoulders")
    cut = full[full.index < d.breakout]  # everything known the day before the breakout
    assert not found(cut, "head_shoulders")
    [f] = found(cut, "head_shoulders", forming=True)  # ...but it shows as forming
    assert f.status == "forming" and f.breakout is None and f.distance > 0


def test_lifecycle_target_hit_or_failed():
    [hit] = found(path(100, 120, 105, 132, 105, 120, 90, 70), "head_shoulders")
    assert hit.status == "target_hit" and hit.resolved is not None
    [failed] = found(path(100, 120, 105, 132, 105, 120, 100, 125), "head_shoulders")
    assert failed.status == "failed"


def test_small_wiggles_are_not_swings():
    close = 100 + np.tile([0, 1, 2, 1], 50).astype(float)  # 2% ripples
    assert len(patterns.pivots(close, close, 0.03)) <= 1  # never a high-low swing
    bars = pd.DataFrame({"close": close}, index=pd.bdate_range("2024-01-01", periods=200))
    assert patterns.detect("X", bars) == []


def test_swing_size_scales_with_volatility():
    close = np.r_[np.linspace(100, 106, 10), np.linspace(106, 100, 10), np.full(10, 100.0)]
    calm = patterns.pivots(close, close, 0.03)
    wild = patterns.pivots(close, close, 0.10)  # a volatile stock needs a bigger move
    assert len(calm) > len(wild)


def test_one_label_per_formation():
    hs = path(100, 120, 105, 132, 105, 120, 90, 85)
    dets = patterns.detect("X", hs)
    spans = [(d.start, d.breakout) for d in dets]
    for i, (a0, a1) in enumerate(spans):
        for b0, b1 in spans[i + 1:]:
            assert a1 < b0 or b1 < a0  # no two labels on the same price action


def test_promoter_context_and_returns():
    bars = path(100, 120, 105, 132, 105, 120, 90, 85)
    det = patterns.to_frame(patterns.detect("X", bars))
    events = pd.DataFrame({"symbol": ["X"], "direction": ["buy"], "event_date": [bars.index[20]],
                           "signed_value": [5e6], "internal_transfer": [False]})
    ctx = patterns.with_promoter_context(det, events)
    hs = ctx[ctx["pattern"] == "head_shoulders"].iloc[0]
    assert hs["promoter_buys"] == 1 and hs["promoter_buying"]
    out = patterns.with_returns(ctx, lambda s: bars["close"], pd.Series(100.0, index=bars.index))
    assert "signed_20" in out
    rows = {r["pattern"]: r for r in patterns.stats(out)}
    assert rows["head_shoulders"]["count"] == 1 and rows["cup_handle"]["count"] == 0
    assert set(rows["head_shoulders"]["tiers"]) == {"High", "Medium", "Low"}
