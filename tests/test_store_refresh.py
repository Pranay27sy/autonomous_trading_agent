import json
from datetime import date
from pathlib import Path

import pandas as pd

from promoter_tracker import refresh
from promoter_tracker.nse_client import parse_response
from promoter_tracker.prices import BENCHMARK, refresh_prices
from promoter_tracker.store import Store

FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_sample.json"


def sample():
    return parse_response(json.loads(FIXTURE.read_text()))


def test_upsert_is_idempotent(tmp_path):
    store = Store(tmp_path / "t.db")
    assert store.upsert_trades(sample()) == 7
    assert store.upsert_trades(sample()) == 0
    assert len(store.load_trades()) == 7
    assert store.last_disclosure_date() == "2024-02-22"


def test_disclosure_window():
    today = date(2024, 3, 1)
    assert refresh.disclosure_window(None, today, 365) == (date(2023, 3, 2), today)
    assert refresh.disclosure_window("2024-02-22", today, 365) == (date(2024, 2, 15), today)


def test_refresh_prices_incremental_and_split_reload(tmp_path):
    store = Store(tmp_path / "t.db")
    calls = []
    full = pd.Series([100.0, 101, 102, 103], index=pd.bdate_range("2024-01-01", periods=4))

    def dl(ticker, start):
        calls.append(start)
        return full[full.index >= pd.Timestamp(start)]

    assert refresh_prices(store, "X.NS", start=date(2024, 1, 1), downloader=dl) == 4
    refresh_prices(store, "X.NS", downloader=dl)
    assert calls[-1] == date(2023, 12, 30)  # last cached (Jan 4) minus 5 days

    # A 1:2 split rewrites adjusted history -> full reload.
    full = full / 2
    refresh_prices(store, "X.NS", start=date(2024, 1, 1), downloader=dl)
    assert calls[-1] == date(2024, 1, 1)
    assert store.load_prices("X.NS").iloc[0] == 50.0


class FakeClient:
    def __init__(self):
        self.ranges = []

    def fetch_pit(self, start, end):
        self.ranges.append((start, end))
        return sample()


def test_refresh_all_pulls_disclosures_and_prices(tmp_path):
    store = Store(tmp_path / "t.db")
    client = FakeClient()
    tickers = []

    def dl(ticker, start):
        tickers.append(ticker)
        return pd.Series([1.0, 2.0], index=pd.bdate_range("2024-01-01", periods=2))

    res = refresh.refresh_all(store, 30, client=client, downloader=dl, today=date(2024, 3, 1))
    assert res.new_trades == 7 and not res.errors
    assert client.ranges[0] == (date(2024, 1, 31), date(2024, 3, 1))
    assert tickers[0] == BENCHMARK and "ABCLTD.NS" in tickers
    assert store.get_meta("last_refresh")

    # Second run starts from the last disclosure minus the overlap.
    refresh.refresh_all(store, 30, client=client, downloader=dl, today=date(2024, 3, 1))
    assert client.ranges[1][0] == date(2024, 2, 15)


def test_refresh_all_reports_nse_failure(tmp_path):
    class Broken:
        def fetch_pit(self, start, end):
            raise RuntimeError("blocked")

    store = Store(tmp_path / "t.db")
    res = refresh.refresh_all(store, 30, client=Broken(), downloader=lambda t, s: pd.Series(dtype=float))
    assert res.errors and "blocked" in res.errors[0]
    assert store.get_meta("last_refresh") is None
