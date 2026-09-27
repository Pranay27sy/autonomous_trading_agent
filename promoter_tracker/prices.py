"""Daily close prices from Yahoo Finance (via yfinance), cached in SQLite."""
from __future__ import annotations

import logging
from datetime import date, timedelta

import pandas as pd

from .store import Store

log = logging.getLogger(__name__)

BENCHMARK = "^NSEI"  # Nifty 50
DEFAULT_START = date(2015, 1, 1)


def nse_ticker(symbol: str) -> str:
    return f"{symbol.upper()}.NS"


def download_closes(ticker: str, start: date) -> pd.Series:
    import yfinance as yf

    df = yf.download(ticker, start=start.isoformat(), progress=False,
                     auto_adjust=True, threads=False)
    if df is None or df.empty:
        return pd.Series(dtype=float, name=ticker)
    close = df["Close"]
    if isinstance(close, pd.DataFrame):  # yfinance returns MultiIndex columns
        close = close.iloc[:, 0]
    close.index = pd.to_datetime(close.index).tz_localize(None)
    return close.rename(ticker)


def refresh_prices(store: Store, ticker: str, start: date = DEFAULT_START,
                   downloader=download_closes) -> int:
    """Fetch bars newer than what is cached. Returns the number of rows written."""
    last = store.last_price_date(ticker)
    fetch_from = date.fromisoformat(last) - timedelta(days=5) if last else start
    if fetch_from > date.today():
        return 0
    try:
        closes = downloader(ticker, fetch_from)
    except Exception as err:  # network / delisted symbol; keep going with other tickers
        log.warning("Price download failed for %s: %s", ticker, err)
        return 0
    if last and _split_detected(store.load_prices(ticker), closes):
        # Adjusted history changed (split/bonus/dividend adjustment): reload it all.
        log.info("Adjusted prices changed for %s; reloading full history", ticker)
        try:
            closes = downloader(ticker, start)
        except Exception as err:
            log.warning("Price download failed for %s: %s", ticker, err)
            return 0
    return store.upsert_prices(ticker, closes)


def _split_detected(cached: pd.Series, fresh: pd.Series, tol: float = 0.01) -> bool:
    common = cached.index.intersection(fresh.index)
    if common.empty:
        return False
    drift = (fresh.loc[common] / cached.loc[common] - 1).abs()
    return bool((drift > tol).any())
