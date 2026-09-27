import json
import sqlite3
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

    def fetch_pit(self, start, end, on_chunk=None):
        self.ranges.append((start, end))
        trades = sample()
        if on_chunk:
            on_chunk(trades)
        return trades


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
        def fetch_pit(self, start, end, on_chunk=None):
            raise RuntimeError("blocked")

    store = Store(tmp_path / "t.db")
    res = refresh.refresh_all(store, 30, client=Broken(), downloader=lambda t, s: pd.Series(dtype=float))
    assert res.errors and "blocked" in res.errors[0]
    assert store.get_meta("last_refresh") is None
    assert store.get_meta("last_refresh_attempt")  # the app won't retry on every session


def test_refresh_keeps_chunks_saved_before_a_failure(tmp_path):
    class DiesLate:
        def fetch_pit(self, start, end, on_chunk=None):
            on_chunk(sample())
            raise RuntimeError("listing failed")

    store = Store(tmp_path / "t.db")
    res = refresh.refresh_all(store, 30, client=DiesLate(),
                              downloader=lambda t, s: pd.Series(dtype=float), today=date(2024, 3, 1))
    assert res.errors and res.new_trades == 7
    assert len(store.load_trades()) == 7


def test_refresh_all_warns_when_nse_goes_quiet(tmp_path):
    store = Store(tmp_path / "t.db")
    res = refresh.refresh_all(store, 30, client=FakeClient(),
                              downloader=lambda t, s: pd.Series(dtype=float), today=date(2024, 6, 1))
    assert not res.errors
    assert res.warnings and "no disclosures after" in res.warnings[0]


def test_refresh_all_reports_failed_filings(tmp_path):
    a, b = {"xmlFileName": "a.xml"}, {"xmlFileName": "b.xml"}

    class Partial(FakeClient):
        failed_filings = [a, b]
        retried = []

        def retry_filings(self, filings):
            self.retried.append(filings)
            self.failed_filings = [b]  # a succeeds this time, b fails again
            return []

    store = Store(tmp_path / "t.db")
    client = Partial()
    no_prices = lambda t, s: pd.Series(dtype=float)  # noqa: E731
    res = refresh.refresh_all(store, 30, client=client, downloader=no_prices, today=date(2024, 3, 1))
    assert res.new_trades == 7
    assert res.errors == ["NSE disclosures: 2 filings could not be downloaded; "
                          "they will be retried on the next refresh"]
    assert store.failed_filings() == [a, b]

    client.failed_filings = []
    res = refresh.refresh_all(store, 30, client=client, downloader=no_prices, today=date(2024, 3, 1))
    assert client.retried == [[a, b]]
    assert store.failed_filings() == [b]
    assert len(res.errors) == 1 and res.errors[0].startswith("NSE disclosures: 1 filings")


def _xbrl_trade(filing_id, quantity, replaces=None):
    t = dict(sample()[0], filing_id=filing_id, quantity=quantity)
    if replaces:
        t["replaces"] = replaces
    return t


def test_revision_replaces_original_stored_earlier(tmp_path):
    store = Store(tmp_path / "t.db")
    store.upsert_trades([_xbrl_trade("A:1", 100)])
    store.upsert_trades([_xbrl_trade("A:2", 120, replaces="A:1")])
    assert list(store.load_trades()["quantity"]) == [120]
    # Re-fetching the original later (overlap window, retry) doesn't bring it back.
    assert store.upsert_trades([_xbrl_trade("A:1", 100)]) == 0
    assert list(store.load_trades()["quantity"]) == [120]


def test_refetch_tags_rows_stored_without_filing_id(tmp_path):
    store = Store(tmp_path / "t.db")
    store.upsert_trades([_xbrl_trade(None, 100)])
    assert store.upsert_trades([_xbrl_trade("A:1", 100)]) == 0  # same trade, now tagged
    store.upsert_trades([_xbrl_trade("A:2", 120, replaces="A:1")])
    assert list(store.load_trades()["quantity"]) == [120]


def test_old_database_gets_new_columns(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE trades (trade_key TEXT PRIMARY KEY, symbol TEXT, company TEXT, "
                 "person TEXT, category TEXT, security_type TEXT, quantity REAL, value REAL, "
                 "txn_type TEXT, mode TEXT, holding_before_pct REAL, holding_after_pct REAL, "
                 "trade_from TEXT, trade_to TEXT, intimation_date TEXT, disclosure_date TEXT)")
    conn.execute("INSERT INTO trades (trade_key, symbol, disclosure_date) "
                 "VALUES ('k', 'OLD', '2024-01-01')")
    conn.commit()
    conn.close()
    store = Store(path)
    assert store.upsert_trades(sample()) == 7
    df = store.load_trades()
    assert len(df) == 8 and not df.loc[df["symbol"] == "OLD", "disclosure_estimated"].iloc[0]


def test_refresh_all_since_overrides_window(tmp_path):
    store = Store(tmp_path / "t.db")
    client = FakeClient()
    refresh.refresh_all(store, 30, client=client, downloader=lambda t, s: pd.Series(dtype=float),
                        today=date(2024, 3, 1), since=date(2023, 12, 1))
    assert client.ranges[0] == (date(2023, 12, 1), date(2024, 3, 1))
