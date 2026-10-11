import json
import sqlite3
from datetime import date
from pathlib import Path

import pandas as pd

from promoter_tracker import refresh
from promoter_tracker.nse_client import _fill_disclosure_date as fill_disclosure
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
    # A future date in the cache still leaves a window that ends today.
    assert refresh.disclosure_window("2062-02-22", today, 365) == (date(2024, 2, 23), today)


def test_estimated_future_date_does_not_stall_refresh(tmp_path):
    store = Store(tmp_path / "t.db")
    typo = dict(sample()[0], person="Typo", disclosure_date=None, trade_to=None,
                intimation_date="2062-02-20")
    store.upsert_trades(sample() + [fill_disclosure(typo)])
    assert store.last_disclosure_date() == "2024-02-22"

    client = FakeClient()
    refresh.refresh_all(store, 30, client=client, downloader=lambda t, s: pd.Series(dtype=float),
                        today=date(2024, 3, 1))
    assert client.ranges[0] == (date(2024, 2, 15), date(2024, 3, 1))


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


def _bars(closes: pd.Series) -> pd.DataFrame:
    return pd.DataFrame({"open": closes - 1, "high": closes + 2, "low": closes - 2,
                         "close": closes, "volume": 1000.0}, index=closes.index)


def test_old_prices_table_gets_ohlc_columns(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE prices (ticker TEXT NOT NULL, date TEXT NOT NULL, "
                 "close REAL NOT NULL, PRIMARY KEY (ticker, date))")
    conn.execute("INSERT INTO prices VALUES ('X.NS', '2024-01-01', 100.0)")
    conn.commit()
    conn.close()
    store = Store(path)
    bars = store.load_bars("X.NS")
    assert bars["close"].iloc[0] == 100.0 and pd.isna(bars["open"].iloc[0])
    assert store.missing_ohlc("X.NS")


def test_bars_round_trip(tmp_path):
    store = Store(tmp_path / "t.db")
    bars = _bars(pd.Series([100.0, 101.0], index=pd.bdate_range("2024-01-01", periods=2)))
    assert store.upsert_prices("X.NS", bars) == 2
    back = store.load_bars("X.NS")
    assert list(back.columns) == ["open", "high", "low", "close", "volume"]
    assert back.iloc[1].to_dict() == {"open": 100.0, "high": 103.0, "low": 99.0,
                                      "close": 101.0, "volume": 1000.0}
    assert not store.missing_ohlc("X.NS")
    assert list(store.load_prices("X.NS")) == [100.0, 101.0]


def test_close_only_cache_is_reloaded_once_with_candles(tmp_path):
    store = Store(tmp_path / "t.db")
    full = pd.Series([100.0, 101, 102, 103], index=pd.bdate_range("2024-01-01", periods=4))
    store.upsert_prices("X.NS", full.iloc[:3])  # cached before candles were stored
    calls = []

    def dl(ticker, start):
        calls.append(start)
        return _bars(full[full.index >= pd.Timestamp(start)])

    refresh_prices(store, "X.NS", start=date(2024, 1, 1), downloader=dl)
    assert calls == [date(2023, 12, 29), date(2024, 1, 1)]  # incremental, then full reload
    assert not store.missing_ohlc("X.NS") and len(store.load_bars("X.NS")) == 4
    refresh_prices(store, "X.NS", start=date(2024, 1, 1), downloader=dl)
    assert len(calls) == 3  # back to incremental only


def test_full_reload_drops_bars_the_source_no_longer_has(tmp_path):
    store = Store(tmp_path / "t.db")
    days = pd.bdate_range("2024-01-01", periods=4)
    store.upsert_prices("X.NS", pd.Series([100.0, 101, 102, 103], index=days))
    fresh = pd.Series([100.0, 101, 103], index=days.delete(2))  # day 3 was a holiday after all

    refresh_prices(store, "X.NS", start=date(2024, 1, 1),
                   downloader=lambda t, s: _bars(fresh[fresh.index >= pd.Timestamp(s)]))
    assert len(store.load_bars("X.NS")) == 3 and not store.missing_ohlc("X.NS")


def test_empty_full_reload_keeps_the_cache(tmp_path):
    store = Store(tmp_path / "t.db")
    days = pd.bdate_range("2024-01-01", periods=3)
    store.upsert_prices("X.NS", pd.Series([100.0, 101, 102], index=days))
    calls = []

    def dl(ticker, start):
        calls.append(start)
        # A changed last close forces a full reload, which then comes back empty.
        if len(calls) == 1:
            return _bars(pd.Series([100.0], index=days[-1:]))
        return _bars(pd.Series(dtype=float))

    refresh_prices(store, "X.NS", start=date(2024, 1, 1), downloader=dl)
    assert len(calls) == 2 and len(store.load_bars("X.NS")) == 3


def test_filings_nse_deleted_warn_but_do_not_fail_the_refresh(tmp_path):
    gone = {"symbol": "NURECA", "appId": "834", "xmlFileName": "g.xml",
            "broadcastDateTime": "09-Jun-2026 18:00:01"}

    class Gone(FakeClient):
        failed_filings: list = []
        missing_filings = [gone]

        def retry_filings(self, filings):
            return []

    store = Store(tmp_path / "t.db")
    store.set_failed_filings([gone])  # queued by an earlier refresh
    res = refresh.refresh_all(store, 30, client=Gone(), downloader=lambda t, s: pd.Series(dtype=float),
                              today=date(2024, 3, 1))
    assert not res.errors and store.get_meta("last_refresh")
    assert store.failed_filings() == []
    assert any("NURECA" in w for w in res.warnings)


def test_latest_closes_in_one_query(tmp_path):
    store = Store(tmp_path / "t.db")
    store.upsert_prices("A.NS", pd.Series([1.0, 2.0], index=pd.bdate_range("2024-01-01", periods=2)))
    store.upsert_prices("B.NS", pd.Series([5.0], index=pd.bdate_range("2024-01-01", periods=1)))
    assert store.latest_closes(["A.NS", "B.NS", "C.NS"]) == {"A.NS": 2.0, "B.NS": 5.0}
