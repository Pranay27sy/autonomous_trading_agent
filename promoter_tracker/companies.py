"""Sector, industry and market cap per stock, from Yahoo Finance, cached in SQLite.

Looked up once per stock and again when older than INFO_MAX_AGE_DAYS; a failed
lookup is remembered too, so delisted symbols aren't retried every refresh.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Callable

import pandas as pd

from .prices import nse_ticker
from .store import Store

log = logging.getLogger(__name__)

INFO_MAX_AGE_DAYS = 30

# Market-cap buckets in INR (approximating SEBI's large/mid/small-cap split).
CRORE = 1e7
BUCKETS = (("Large cap", 50_000 * CRORE), ("Mid cap", 15_000 * CRORE),
           ("Small cap", 2_000 * CRORE), ("Micro cap", 0.0))


def fetch_info(symbol: str) -> dict:
    import yfinance as yf

    info = yf.Ticker(nse_ticker(symbol)).info or {}
    if info.get("currency") not in (None, "INR"):
        raise ValueError(f"unexpected currency {info.get('currency')}")
    return {"name": info.get("longName") or info.get("shortName"),
            "sector": info.get("sector"), "industry": info.get("industry"),
            "market_cap": info.get("marketCap"),
            "shares_outstanding": info.get("sharesOutstanding")}


def stale_symbols(store: Store, symbols: list[str], max_age_days: int = INFO_MAX_AGE_DAYS,
                  now: datetime | None = None) -> list[str]:
    now = now or datetime.now(timezone.utc)
    ages = store.company_info_age()
    cutoff = now - timedelta(days=max_age_days)
    return [s for s in symbols if s not in ages or datetime.fromisoformat(ages[s]) < cutoff]


def refresh_company_info(store: Store, symbols: list[str],
                         fetcher: Callable[[str], dict] = fetch_info,
                         progress: Callable[[str], None] = lambda msg: None) -> int:
    """Look up stocks with no or old info. Returns how many were looked up."""
    todo = stale_symbols(store, symbols)
    for i, sym in enumerate(todo, 1):
        if i % 50 == 1:
            progress(f"Company info {i}/{len(todo)}")
        try:
            info = fetcher(sym)
        except Exception as err:  # delisted / renamed / Yahoo hiccup: keep going
            log.warning("Company info for %s failed: %s", sym, err)
            info = {}
        store.upsert_company_info(sym, info)
    return len(todo)


def bucket(market_cap: float | None) -> str | None:
    if market_cap is None or pd.isna(market_cap) or market_cap <= 0:
        return None
    return next(name for name, floor in BUCKETS if market_cap >= floor)


def with_company_info(events: pd.DataFrame, info: pd.DataFrame) -> pd.DataFrame:
    """events plus sector, industry, market_cap and cap_bucket columns."""
    cols = ["sector", "industry", "market_cap"]
    if info.empty:
        out = events.assign(**{c: None for c in cols})
    else:
        out = events.join(info[cols], on="symbol")
    return out.assign(cap_bucket=[bucket(m) for m in out["market_cap"]])
