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


def download_bars(ticker: str, start: date) -> pd.DataFrame:
    """Daily open/high/low/close/volume since start, split- and dividend-adjusted."""
    import yfinance as yf

    df = yf.download(ticker, start=start.isoformat(), progress=False,
                     auto_adjust=True, threads=False)
    if df is None or df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"], dtype=float)
    if isinstance(df.columns, pd.MultiIndex):  # yfinance returns (field, ticker) columns
        df = df.xs(df.columns.get_level_values(1)[0], axis=1, level=1)
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    df.index = pd.to_datetime(df.index).tz_localize(None)
    return df


def _closes(bars: pd.Series | pd.DataFrame) -> pd.Series:
    return bars if isinstance(bars, pd.Series) else bars["close"]


def _has_ohlc(bars: pd.Series | pd.DataFrame) -> bool:
    return isinstance(bars, pd.DataFrame) and "open" in bars and bars["open"].notna().any()


def refresh_prices(store: Store, ticker: str, start: date = DEFAULT_START,
                   downloader=download_bars) -> int:
    """Fetch bars newer than what is cached. Returns the number of rows written.

    downloader(ticker, start) returns a DataFrame of daily bars (or a Series of closes).
    """
    last = store.last_price_date(ticker)
    fetch_from = date.fromisoformat(last) - timedelta(days=5) if last else start
    if fetch_from > date.today():
        return 0
    try:
        bars = downloader(ticker, fetch_from)
    except Exception as err:  # network / delisted symbol; keep going with other tickers
        log.warning("Price download failed for %s: %s", ticker, err)
        return 0
    reload = None
    if last and _split_detected(store.load_prices(ticker), _closes(bars)):
        reload = "Adjusted prices changed"  # split/bonus/dividend adjustment
    elif last and _has_ohlc(bars) and store.missing_ohlc(ticker):
        reload = "Cached bars have no open/high/low"  # cached before candles were stored
    if reload:
        log.info("%s for %s; reloading full history", reload, ticker)
        try:
            full = downloader(ticker, start)
        except Exception as err:
            log.warning("Price download failed for %s: %s", ticker, err)
            return 0
        if len(full):  # never swap a history for an empty download
            return store.upsert_prices(ticker, full, replace=True)
        log.warning("Full reload of %s came back empty; keeping the cached history", ticker)
    return store.upsert_prices(ticker, bars)


def _split_detected(cached: pd.Series, fresh: pd.Series, tol: float = 0.01) -> bool:
    common = cached.index.intersection(fresh.index)
    if common.empty:
        return False
    drift = (fresh.loc[common] / cached.loc[common] - 1).abs()
    return bool((drift > tol).any())
