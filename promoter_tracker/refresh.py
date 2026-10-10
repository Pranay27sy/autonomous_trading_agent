"""Pull the latest disclosures and prices into the local cache.

Run from a scheduler (cron / Task Scheduler) or let the app call it:
    python -m promoter_tracker.refresh --backfill-days 730
Or keep it running and refreshing every few hours (what the Docker setup does):
    python -m promoter_tracker.refresh --every-hours 6

Exit codes: 0 success, 1 refresh finished with errors, 75 another refresh was
already running (try again later).
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable

from filelock import FileLock, Timeout

from . import analysis
from .config import configure_logging, load_settings
from .nse_client import NSEClient
from .prices import BENCHMARK, download_bars, nse_ticker, refresh_prices
from .store import Store

log = logging.getLogger(__name__)

# Companies sometimes file late or revise filings, so re-read a short overlap.
OVERLAP_DAYS = 7
# NSE publishes filings every trading day; a longer silence means the feed broke.
QUIET_DAYS_WARNING = 14

EXIT_ERRORS = 1
EXIT_BUSY = 75  # EX_TEMPFAIL


class RefreshInProgress(RuntimeError):
    """Another refresh (the app, or the scheduled CLI) holds the database."""


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
                downloader=download_bars, today: date | None = None,
                progress: Callable[[str], None] = lambda msg: None,
                since: date | None = None) -> RefreshResult:
    """since forces the disclosure fetch to start there, e.g. to re-pull filings that failed.

    Raises RefreshInProgress if another process is refreshing the same database:
    two refreshes at once would double NSE's request rate and get both blocked.
    """
    # An OS file lock, so it is released even if the process holding it is killed.
    lock = FileLock(f"{store.path}.refresh.lock")
    try:
        lock.acquire(timeout=0)
    except Timeout:
        raise RefreshInProgress("A refresh is already running") from None
    try:
        return _refresh_all(store, backfill_days, client, downloader, today, progress, since)
    finally:
        lock.release()


def _refresh_all(store, backfill_days, client, downloader, today, progress, since) -> RefreshResult:
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
    missing: list[dict] = []

    def collect() -> None:
        failed.extend(getattr(client, "failed_filings", []))
        missing.extend(getattr(client, "missing_filings", []))

    try:
        client.fetch_pit(start, end, on_chunk=save)
        collect()
        if pending:
            progress(f"Retrying {len(pending)} filings that failed to download before")
            save(client.retry_filings(pending))
            pending = []
            collect()
    except Exception as err:
        log.exception("Disclosure refresh failed")
        result.errors.append(f"NSE disclosures: {err}")
        collect()
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
    if missing:
        # NSE deleted these files; retrying can't help, so they don't fail the refresh.
        names = ", ".join(f"{f.get('symbol')} ({f.get('broadcastDateTime', '?')})" for f in missing[:5])
        result.warnings.append(f"NSE no longer has {len(missing)} filing(s), skipped: {names}")

    events = analysis.promoter_events(store.load_trades(), market_only=False)
    symbols = sorted(set(events["symbol"]))
    tickers = [BENCHMARK] + [nse_ticker(s) for s in symbols]
    for i, ticker in enumerate(tickers, 1):
        progress(f"Prices {i}/{len(tickers)}: {ticker}")
        result.price_rows += refresh_prices(store, ticker, downloader=downloader)

    if not result.errors:
        store.mark_refreshed()
    return result


def run_once(store: Store, backfill_days: int, since: date | None = None) -> int:
    """One logged refresh; returns the process exit code."""
    try:
        res = refresh_all(store, backfill_days, progress=log.info, since=since)
    except RefreshInProgress:
        log.warning("Another refresh is already running on %s; skipping this one", store.path)
        return EXIT_BUSY
    log.info("Done: %d new disclosures, %d price rows, %d errors",
             res.new_trades, res.price_rows, len(res.errors))
    for w in res.warnings:
        log.warning(w)
    for e in res.errors:
        log.error(e)
    return EXIT_ERRORS if res.errors else 0


def main(argv: list[str] | None = None) -> int:
    settings = load_settings()
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=str(settings.db_path),
                        help="SQLite path (default: $PROMOTER_DB or data/promoter.db)")
    parser.add_argument("--backfill-days", type=int, default=365,
                        help="History to pull on the first run")
    parser.add_argument("--since", type=date.fromisoformat, default=None,
                        help="Re-fetch disclosures from this date (YYYY-MM-DD), e.g. after failures")
    parser.add_argument("--every-hours", type=float, default=None,
                        help="Keep running and refresh this often instead of exiting")
    args = parser.parse_args(argv)
    configure_logging(settings)
    # docker stop / systemd send SIGTERM; exit through the finally blocks so an
    # open SQLite transaction rolls back and the refresh lock is released.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    store = Store(args.db)
    try:
        if args.every_hours is None:
            return run_once(store, args.backfill_days, args.since)
        since = args.since
        while True:
            run_once(store, args.backfill_days, since)
            since = None  # only the first run re-fetches from --since
            log.info("Next refresh in %.1f hours", args.every_hours)
            time.sleep(args.every_hours * 3600)
    except KeyboardInterrupt:
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
