"""Settings, locking and CLI behaviour that matter when the app runs unattended."""
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest
from filelock import FileLock

from promoter_tracker import refresh
from promoter_tracker.config import DEFAULT_DB, load_settings
from promoter_tracker.nse_client import parse_xbrl
from promoter_tracker.store import Store

no_prices = lambda t, s: pd.Series(dtype=float)  # noqa: E731


class EmptyClient:
    def fetch_pit(self, start, end, on_chunk=None):
        return []


def test_settings_defaults_and_overrides():
    s = load_settings({})
    assert s.db_path == DEFAULT_DB and s.auto_refresh and s.stale_after == timedelta(hours=6)
    assert s.log_file is None
    s = load_settings({"PROMOTER_DB": "/x/p.db", "PROMOTER_AUTO_REFRESH": "0",
                       "PROMOTER_STALE_HOURS": "1.5", "PROMOTER_LOG_LEVEL": "debug",
                       "PROMOTER_LOG_FILE": "/x/app.log"})
    assert s.db_path == Path("/x/p.db") and not s.auto_refresh
    assert s.stale_after == timedelta(minutes=90) and s.log_level == "DEBUG"
    assert s.log_file == Path("/x/app.log")


def test_settings_reject_bad_stale_hours():
    with pytest.raises(ValueError, match="PROMOTER_STALE_HOURS"):
        load_settings({"PROMOTER_STALE_HOURS": "six"})


def test_database_uses_wal(tmp_path):
    store = Store(tmp_path / "t.db")
    assert store.conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_failed_upsert_rolls_back(tmp_path):
    store = Store(tmp_path / "t.db")
    good = {"symbol": "A", "person": "P", "disclosure_date": "2024-01-01", "quantity": 1}
    bad = dict(good, person="Q", quantity=object())  # not storable -> raises mid-batch
    with pytest.raises(Exception):
        store.upsert_trades([good, bad])
    assert store.load_trades().empty
    assert store.upsert_trades([good]) == 1  # connection still usable


def test_refresh_refuses_to_run_twice(tmp_path):
    store = Store(tmp_path / "t.db")
    # Another process (the CLI, or the app) holds the lock.
    with FileLock(f"{store.path}.refresh.lock"):
        with pytest.raises(refresh.RefreshInProgress):
            refresh.refresh_all(store, 30, client=EmptyClient(), downloader=no_prices)
        assert store.get_meta("last_refresh_attempt") is None
    # Released afterwards, so the next run goes ahead.
    refresh.refresh_all(store, 30, client=EmptyClient(), downloader=no_prices,
                        today=date(2024, 3, 1))
    assert store.get_meta("last_refresh_attempt")


def test_cli_exit_codes(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    calls = []

    def fake_refresh(store, backfill_days, progress, since):
        calls.append(since)
        if len(calls) == 2:
            raise refresh.RefreshInProgress()
        errors = ["NSE disclosures: blocked"] if len(calls) == 3 else []
        return refresh.RefreshResult(date(2024, 1, 1), date(2024, 1, 2), errors=errors)

    monkeypatch.setattr(refresh, "refresh_all", fake_refresh)
    assert refresh.main(["--db", str(db), "--since", "2024-01-01"]) == 0
    assert calls == [date(2024, 1, 1)]
    assert refresh.main(["--db", str(db)]) == refresh.EXIT_BUSY
    assert refresh.main(["--db", str(db)]) == refresh.EXIT_ERRORS


def test_xbrl_parser_rejects_entity_expansion():
    bomb = (b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa">'
            b'<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><x>&b;</x>')
    with pytest.raises(Exception, match="(?i)entit"):
        parse_xbrl(bomb)
