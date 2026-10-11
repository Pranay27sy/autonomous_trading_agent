from datetime import datetime, timedelta, timezone

import pandas as pd

from promoter_tracker import companies
from promoter_tracker.store import Store


def test_lookups_are_cached_and_refreshed_when_old(tmp_path):
    store = Store(tmp_path / "t.db")
    calls = []

    def fetch(sym):
        calls.append(sym)
        if sym == "GONE":
            raise ValueError("delisted")
        return {"name": f"{sym} Ltd", "sector": "Industrials", "industry": "Steel",
                "market_cap": 6e11, "shares_outstanding": 1e9}

    assert companies.refresh_company_info(store, ["JSL", "GONE"], fetch) == 2
    assert companies.refresh_company_info(store, ["JSL", "GONE"], fetch) == 0  # cached, failure too
    info = store.company_info()
    assert info.loc["JSL", "sector"] == "Industrials" and pd.isna(info.loc["GONE", "sector"])
    later = datetime.now(timezone.utc) + timedelta(days=31)
    assert companies.stale_symbols(store, ["JSL"], now=later) == ["JSL"]


def test_cap_buckets():
    cr = 1e7
    assert [companies.bucket(v) for v in (60_000 * cr, 20_000 * cr, 5_000 * cr, 100 * cr, None)] == [
        "Large cap", "Mid cap", "Small cap", "Micro cap", None]


def test_with_company_info_joins_by_symbol():
    events = pd.DataFrame({"symbol": ["A", "B"]})
    info = pd.DataFrame({"sector": ["Energy"], "industry": ["Oil"], "market_cap": [3e12]},
                        index=pd.Index(["A"], name="symbol"))
    out = companies.with_company_info(events, info)
    assert list(out["sector"].fillna("-")) == ["Energy", "-"]
    assert list(out["cap_bucket"].fillna("-")) == ["Large cap", "-"]
