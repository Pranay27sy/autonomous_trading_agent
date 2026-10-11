import numpy as np
import pandas as pd

from promoter_tracker import conviction


def test_token_buy_scores_low_and_strong_buy_scores_high():
    low, low_why, _ = conviction.score_buy(0.001, 5e5, 5e7, 1, 0, 0.0)
    high, high_why, f = conviction.score_buy(1.2, 6e8, 1e8, 4, 3, 0.4)
    assert low < 10 and low_why == []
    assert high == 100 and all(v == 1 for v in f.values())
    assert high_why[0] == "raised their stake by 1.20% of the company"
    assert "4 promoters buying within 30 days" in high_why


def _buy(person, day, value=1e7, stake=0.1, symbol="ABC"):
    return {"symbol": symbol, "person": person, "direction": "buy", "value": value,
            "holding_change_pct": stake, "event_date": pd.Timestamp(day),
            "internal_transfer": False, "market_cap": None}


def test_cluster_repeat_and_dip_come_from_history():
    days = pd.bdate_range("2023-01-02", periods=300)
    close = pd.Series(np.r_[np.full(200, 100.0), np.full(100, 60.0)], index=days)  # 40% fall
    bars = pd.DataFrame({"close": close, "volume": 1e5})  # ₹1 cr a day while at 100
    events = pd.DataFrame([
        _buy("A", "2024-01-02"), _buy("A", "2024-01-09"), _buy("B", "2024-01-10"),
        _buy("C", "2024-01-11"),
        {**_buy("D", "2024-01-11"), "direction": "sell"},
    ])
    out = conviction.add_conviction(events, lambda s: bars)
    last = out.iloc[3]  # C: 3 promoters within 30 days, price 40% below its high
    assert any("3 promoters" in r for r in last["conviction_reasons"])
    assert any("below its 52-week high" in r for r in last["conviction_reasons"])
    assert any("2nd buy by this person" in r for r in out.iloc[1]["conviction_reasons"])
    assert pd.isna(out.iloc[4]["conviction"])  # sells get no score
    assert out["conviction"].iloc[3] > out["conviction"].iloc[0]


def test_transfers_get_no_score():
    events = pd.DataFrame([{**_buy("A", "2024-01-02"), "internal_transfer": True}])
    out = conviction.add_conviction(events, lambda s: pd.DataFrame(columns=["close", "volume"]))
    assert pd.isna(out.iloc[0]["conviction"])
