import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from promoter_tracker import analysis
from promoter_tracker.nse_client import parse_response
from promoter_tracker.store import Store

FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_sample.json"


@pytest.fixture
def trades(tmp_path):
    store = Store(tmp_path / "t.db")
    store.upsert_trades(parse_response(json.loads(FIXTURE.read_text())))
    return store.load_trades()


def test_promoter_events_filters_category_direction_and_mode(trades):
    ev = analysis.promoter_events(trades, market_only=True)
    # Director sale, pledge and off-market transfer are excluded.
    assert sorted(zip(ev["symbol"], ev["direction"])) == [
        ("ABCLTD", "buy"), ("ABCLTD", "buy"), ("NEWFMT", "buy"), ("XYZIND", "sell")]
    all_modes = analysis.promoter_events(trades, market_only=False)
    assert ("ABCLTD", "sell") in set(zip(all_modes["symbol"], all_modes["direction"]))


def test_event_date_basis(trades):
    by_disc = analysis.promoter_events(trades, event_date="disclosure_date")
    by_trade = analysis.promoter_events(trades, event_date="trade_to")
    ravi = lambda df: df[df["person"] == "Ravi Kumar"]["event_date"].iloc[0]
    assert ravi(by_disc) == pd.Timestamp("2024-01-05")
    assert ravi(by_trade) == pd.Timestamp("2024-01-03")


def test_trade_direction():
    assert analysis.trade_direction("Buy", "") == "buy"
    assert analysis.trade_direction("Pledge", "Market Purchase") is None
    assert analysis.trade_direction("", "Market Sale") == "sell"
    assert analysis.trade_direction("", "Gift") is None
    assert not analysis.is_market_trade("Off Market")
    assert analysis.is_market_trade("Market Purchase")


def _prices(start="2024-01-01", n=200, growth=0.01):
    idx = pd.bdate_range(start, periods=n)
    return pd.Series(100 * (1 + growth) ** np.arange(n), index=idx)


def test_forward_returns_enter_next_trading_day():
    px = _prices()
    r = analysis.forward_returns(px, pd.Timestamp("2024-01-05"), horizons=(1, 5, 500))
    assert r[1] == pytest.approx(0.01)
    assert r[5] == pytest.approx(1.01 ** 5 - 1)
    assert np.isnan(r[500])
    # Weekend event: entry is Monday's close either way.
    sat = analysis.forward_returns(px, pd.Timestamp("2024-01-06"), horizons=(1,))
    fri = analysis.forward_returns(px, pd.Timestamp("2024-01-05"), horizons=(1,))
    assert sat == fri


def test_excess_return_against_benchmark(trades):
    ev = analysis.promoter_events(trades)
    stock = _prices(growth=0.01)
    bench = _prices(growth=0.005)
    out = analysis.event_returns(ev, lambda s: stock if s == "ABCLTD" else pd.Series(dtype=float),
                                 bench, horizons=(5,))
    abc = out[out["symbol"] == "ABCLTD"].iloc[0]
    assert abc["ret_5"] == pytest.approx(1.01 ** 5 - 1)
    assert abc["exc_5"] == pytest.approx((1.01 ** 5 - 1) - (1.005 ** 5 - 1))
    assert np.isnan(out[out["symbol"] == "XYZIND"]["ret_5"].iloc[0])


def test_summarize_clusters_and_leaderboard(trades):
    ev = analysis.promoter_events(trades)
    ev = analysis.event_returns(ev, lambda s: _prices(), _prices(growth=0.0), horizons=(5,))
    summ = analysis.summarize(ev, horizons=(5,))
    buy = summ[summ["direction"] == "buy"].iloc[0]
    assert buy["events"] == 3 and buy["hit_rate"] == 1.0

    cl = analysis.clusters(ev, min_people=2, window_days=30)
    assert list(cl["symbol"]) == ["ABCLTD"] and cl["promoters"].iloc[0] == 2
    assert analysis.clusters(ev, min_people=2, window_days=3).empty

    lb = analysis.leaderboard(ev)
    assert lb.iloc[0]["symbol"] == "ABCLTD"
    assert lb.iloc[-1]["symbol"] == "XYZIND" and lb.iloc[-1]["net_value"] == -40_000_000
