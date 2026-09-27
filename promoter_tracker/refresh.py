"""Pull the latest disclosures and prices into the local cache.

Run from a scheduler (cron / Task Scheduler) or let the app call it:
    python -m promoter_tracker.refresh --backfill-days 730
"""
from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable

from . import analysis
from .nse_client import NSEClient
from .prices import BENCHMARK, download_closes, nse_ticker, refresh_prices
from .store import Store

log = logging.getLogger(__name__)

# Companies sometimes file late or revise filings, so re-read a short overlap.
OVERLAP_DAYS = 7
# NSE publishes filings every trading day; a longer silence means the feed broke.
QUIET_DAYS_WARNING = 14


@dataclass
class RefreshResult:
    fetched_from: date
    fetched_to: date
    new_trades: int = 0
    price_rows: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def disclosure_window(last: str | None, today: date, backfill_days: int) -> tuple[date, date]:
    if last:
        # Never start after today, or a bad date in the cache would stop all fetching.
        start = min(date.fromisoformat(last), today) - timedelta(days=OVERLAP_DAYS)
    else:
        start = today - timedelta(days=backfill_days)
    return start, today


def refresh_all(store: Store, backfill_days: int = 365, client: NSEClient | None = None,
                downloader=download_closes, today: date | None = None,
                progress: Callable[[str], None] = lambda msg: None,
                since: date | None = None) -> RefreshResult:
    """since forces the disclosure fetch to start there, e.g. to re-pull filings that failed."""
    today = today or date.today()
    start, end = disclosure_window(store.last_disclosure_date(), today, backfill_days)
    if since:
        start = since
    result = RefreshResult(start, end)

    store.mark_refresh_attempt()
    progress(f"Fetching NSE insider disclosures {start} → {end}")
    client = client or NSEClient(progress=progress)

    def save(chunk: list[dict]) -> None:
        # Saved chunk by chunk so a failure late in a long backfill keeps the rest.
        result.new_trades += store.upsert_trades(chunk)

    pending = store.failed_filings()
    failed: list[dict] = []
    try:
        client.fetch_pit(start, end, on_chunk=save)
        failed += getattr(client, "failed_filings", [])
        if pending:
            progress(f"Retrying {len(pending)} filings that failed to download before")
            save(client.retry_filings(pending))
            pending = []
            failed += getattr(client, "failed_filings", [])
    except Exception as err:
        log.exception("Disclosure refresh failed")
        result.errors.append(f"NSE disclosures: {err}")
        failed += getattr(client, "failed_filings", [])
    else:
        latest = store.last_disclosure_date()
        if latest and (end - date.fromisoformat(latest)).days > QUIET_DAYS_WARNING:
            result.warnings.append(
                f"NSE returned no disclosures after {latest}. Its API may have changed again."
            )
    # Anything not retried yet stays queued alongside this run's failures.
    store.set_failed_filings(pending + failed)
    if failed:
        result.errors.append(f"NSE disclosures: {len(failed)} filings could not be downloaded; "
                             "they will be retried on the next refresh")

    events = analysis.promoter_events(store.load_trades(), market_only=False)
    symbols = sorted(set(events["symbol"]))
    tickers = [BENCHMARK] + [nse_ticker(s) for s in symbols]
    for i, ticker in enumerate(tickers, 1):
        progress(f"Prices {i}/{len(tickers)}: {ticker}")
        result.price_rows += refresh_prices(store, ticker, downloader=downloader)

    if not result.errors:
        store.mark_refreshed()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=None, help="SQLite path (default data/promoter.db)")
    parser.add_argument("--backfill-days", type=int, default=365,
                        help="History to pull on the first run")
    parser.add_argument("--since", type=date.fromisoformat, default=None,
                        help="Re-fetch disclosures from this date (YYYY-MM-DD), e.g. after failures")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = Store(args.db) if args.db else Store()
    res = refresh_all(store, args.backfill_days, progress=log.info, since=args.since)
    log.info("Done: %d new disclosures, %d price rows, %d errors",
             res.new_trades, res.price_rows, len(res.errors))
    for w in res.warnings:
        log.warning(w)
    for e in res.errors:
        log.error(e)


if __name__ == "__main__":
    main()
