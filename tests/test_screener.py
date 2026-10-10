import numpy as np
import pandas as pd

from promoter_tracker import screener

DAYS = pd.bdate_range("2023-06-01", periods=400)


def ev(symbol, person, day, direction="buy", value=1e7, conviction=40, **kw):
    return {"symbol": symbol, "company": symbol, "person": person, "direction": direction,
            "event_date": pd.Timestamp(day), "value": value,
            "signed_value": value if direction == "buy" else -value,
            "conviction": conviction if direction == "buy" else np.nan,
            "internal_transfer": False, "sector": "Industrials", "cap_bucket": "Small cap", **kw}


EVENTS = pd.DataFrame([
    ev("CLUS", "A", "2024-12-20"), ev("CLUS", "B", "2024-12-21"), ev("CLUS", "C", "2024-12-22"),
    ev("DIP", "D", "2024-12-15", conviction=70),
    ev("SELL", "E", "2024-12-10", direction="sell", value=5e8),
    ev("OLD", "F", "2023-07-01"),  # outside a 90-day window
])
PRICES = {
    "CLUS": pd.Series(np.linspace(100, 110, len(DAYS)), index=DAYS),
    "DIP": pd.Series(np.r_[np.full(300, 100.0), np.full(100, 60.0)], index=DAYS),  # 40% off its high
    "SELL": pd.Series(100.0, index=DAYS),
    "OLD": pd.Series(100.0, index=DAYS),
}
ROWS = screener.metrics(EVENTS, PRICES.__getitem__, 90, {"SELL": "high"})


def test_metrics_cover_the_window():
    assert set(ROWS["symbol"]) == {"CLUS", "DIP", "SELL"}
    clus = ROWS.set_index("symbol").loc["CLUS"]
    assert clus["promoters"] == 3 and clus["buys"] == 3 and clus["net_value"] == 3e7
    assert ROWS.set_index("symbol").loc["DIP", "below_high"] == 0.4


def test_criteria_filter_and_sort():
    def names(**c):
        return list(screener.screen(ROWS, screener.Criteria(**c))["symbol"])
    assert names(min_promoters=3) == ["CLUS"]
    assert names(min_conviction=60, min_below_high=0.3) == ["DIP"]
    assert names(exclude_pledge_risk=True, sort="net_value") == ["CLUS", "DIP"]
    assert names(min_net_value=0) == ["CLUS", "DIP"]
    assert names(sectors=("Energy",)) == []


def test_presets_and_round_trip():
    c = screener.PRESETS["Fresh clusters"]
    assert screener.Criteria.from_dict(c.to_dict()) == c
    assert screener.Criteria.from_dict({"caps": ["Small cap"], "junk": 1}).caps == ("Small cap",)
