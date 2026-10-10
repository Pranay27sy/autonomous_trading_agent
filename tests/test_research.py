import numpy as np
import pandas as pd
import pytest

from promoter_tracker import research

DAYS = pd.bdate_range("2024-01-01", periods=200)
BENCH = pd.Series(100.0, index=DAYS)  # flat Nifty: excess = raw return


def stock(jump_at: int, jump: float) -> pd.Series:
    """Flat at 100, then a one-off move on day jump_at."""
    return pd.Series(np.where(np.arange(len(DAYS)) >= jump_at, 100 * (1 + jump), 100.0), index=DAYS)


PRICES = {"UP": stock(15, 0.10), "DOWN": stock(15, -0.05), "LATE": stock(15, 0.10)}


def ev(symbol, day_index, direction="buy", conviction=50, value=1e7, **kw):
    return {"symbol": symbol, "company": symbol, "person": "P", "direction": direction,
            "event_date": DAYS[day_index], "value": value, "conviction": conviction,
            "holding_change_pct": 0.2, "internal_transfer": False, "returns_valid": True,
            "sector": "Industrials", "cap_bucket": "Small cap", **kw}


EVENTS = pd.DataFrame([
    ev("UP", 10), ev("DOWN", 10, conviction=10),
    ev("LATE", 195),  # too recent for a 20-day hold
    ev("UP", 11, internal_transfer=True),  # transfers never trade
    ev("DOWN", 5, direction="sell"),
])


def run(**rule):
    return research.backtest(EVENTS, PRICES.__getitem__, BENCH, research.Rule(hold_days=20, **rule))


def test_backtest_trades_selected_events_and_scores_them():
    out = run()
    st = out["stats"]
    assert st["trades"] == 2 and st["hit_rate"] == 0.5
    assert st["mean_excess"] == pytest.approx((0.10 - 0.05) / 2)
    by = {t["symbol"]: t for t in out["trades"]}
    assert by["UP"]["entry"] == DAYS[11] and by["UP"]["return"] == pytest.approx(0.10)
    # Both held from day 11 to 31: the equal-weight portfolio ends +2.5%.
    assert out["equity"][-1]["strategy"] == pytest.approx(1.025, abs=1e-6)
    assert out["equity"][-1]["benchmark"] == pytest.approx(1.0)


def test_rule_filters_and_short_side():
    assert run(min_conviction=40)["stats"]["trades"] == 1
    assert run(sectors=("Energy",))["stats"]["trades"] == 0
    short = run(side="sell")
    assert short["stats"]["trades"] == 1 and short["trades"][0]["excess"] == pytest.approx(0.05)


def test_one_signal_per_stock_window():
    events = pd.DataFrame([ev("UP", 1), ev("UP", 3), ev("UP", 40)])
    out = research.backtest(events, PRICES.__getitem__, BENCH,
                            research.Rule(hold_days=5, one_per_stock_days=30))
    assert out["stats"]["trades"] == 2


def test_event_study_paths_are_rebased_at_entry():
    out = research.event_study(pd.DataFrame([ev("UP", 10 + k) for k in range(6)]),
                               PRICES.__getitem__, BENCH, before=5, after=10)
    [g] = out["groups"]
    pts = {p["day"]: p for p in g["points"]}
    assert g["group"] == "Promoter buys" and g["events"] == 6
    assert pts[0]["mean"] == 0
    # Entries on days 11-14 come before the jump on day 15; the last two enter after it.
    assert pts[10]["mean"] == pytest.approx(0.10 * 4 / 6, abs=1e-5)  # values are rounded to 5 dp
    assert pts[10]["lo"] <= pts[10]["mean"] <= pts[10]["hi"]
