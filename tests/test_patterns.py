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


def kinds(bars):
    return [d.pattern for d in patterns.detect("X", bars)]


def test_head_and_shoulders_and_its_mirror():
    hs = path(100, 120, 105, 132, 105, 120, 90, 85)
    [d] = [d for d in patterns.detect("X", hs) if d.pattern == "head_shoulders"]
    assert d.direction == "bear" and d.level == pytest.approx(105)
    assert d.target == pytest.approx(105 - (132 - 105))  # measured move from the neckline
    assert [p["label"] for p in d.points][::2] == ["Left shoulder", "Head", "Right shoulder"]
    inv = path(130, 110, 125, 98, 125, 110, 140, 145)
    assert "inverse_head_shoulders" in kinds(inv)


def test_double_top_and_bottom():
    assert "double_top" in kinds(path(100, 130, 115, 131, 100, 95))
    assert "double_bottom" in kinds(path(130, 100, 115, 99, 130, 135))


def test_cup_and_handle():
    bars = path(80, 120, 120, 90, 90, 119, 112, 128, 130, leg=20)
    [d] = [d for d in patterns.detect("X", bars) if d.pattern == "cup_handle"]
    assert d.direction == "bull" and d.level == pytest.approx(120)


def test_ascending_and_descending_triangles():
    assert "ascending_triangle" in kinds(path(90, 120, 100, 120.5, 108, 130, 132))
    assert "descending_triangle" in kinds(path(130, 100, 120, 100.5, 112, 85, 80))


def test_no_detection_before_the_breakout_happens():
    full = path(100, 120, 105, 132, 105, 120, 90, 85)
    [d] = [d for d in patterns.detect("X", full) if d.pattern == "head_shoulders"]
    cut = full[full.index < d.breakout]  # everything known the day before the breakout
    assert "head_shoulders" not in kinds(cut)


def test_small_wiggles_are_not_swings():
    close = 100 + np.tile([0, 1, 2, 1], 50).astype(float)  # 2% ripples
    assert len(patterns.pivots(close)) <= 1  # never a high-low swing, at most a starting point
    assert kinds(pd.DataFrame({"close": close}, index=pd.bdate_range("2024-01-01", periods=200))) == []


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
