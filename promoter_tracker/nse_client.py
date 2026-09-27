"""Fetch and parse SEBI PIT (insider trading) disclosures from NSE.

NSE serves this data through the same unofficial JSON API its website uses.
It needs browser-like headers and the cookies set by the homepage, and it
rate-limits aggressively, so requests are chunked and spaced out.

NSE switched formats on 3 May 2026. Filings up to 2 May come from the old
`corporates-pit` endpoint with every field inline. Later filings come from
`corporates-pit-gg`, which only lists filings; the trade details live in
each filing's XBRL file, so those are downloaded one by one.
"""
from __future__ import annotations

import logging
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable

import requests

log = logging.getLogger(__name__)

BASE_URL = "https://www.nseindia.com"
PIT_URL = f"{BASE_URL}/api/corporates-pit"
PIT_XBRL_URL = f"{BASE_URL}/api/corporates-pit-gg"
# Last day the old endpoint has data; the XBRL endpoint starts the day after.
LEGACY_LAST_DAY = date(2026, 5, 2)
XBRL_WORKERS = 2
# The file archive answers 403 for a couple of minutes once it decides we are
# downloading too fast; every worker waits out this cooldown before retrying.
ARCHIVE_COOLDOWN = 60
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": f"{BASE_URL}/companies-listing/corporate-filings-insider-trading",
}
CHUNK_DAYS = 30

# Canonical column -> NSE field names seen for it. NSE has renamed fields
# before; if a refresh starts returning blanks, add the new name here.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "symbol": ("symbol",),
    "company": ("company", "companyName"),
    "person": ("acqName", "acquirerName", "name"),
    "category": ("personCategory", "category"),
    "security_type": ("secType",),
    "quantity": ("secAcq", "noOfSecurities"),
    "value": ("secVal", "value"),
    "txn_type": ("tdpTransactionType", "transactionType", "acqType"),
    "mode": ("acqMode", "modeOfAcquisition"),
    "holding_before_pct": ("befAcqSharesPer", "beforeAcqSharesPer"),
    "holding_after_pct": ("afterAcqSharesPer",),
    "trade_from": ("acqfromDt", "acqFromDt", "fromDate"),
    "trade_to": ("acqtoDt", "acqToDt", "toDate"),
    "intimation_date": ("intimDt", "intimationDate"),
    "disclosure_date": ("date", "broadcastDate", "disseminationDate"),
    "exchange": ("exchange",),
}

_DATE_FORMATS = (
    "%d-%b-%Y %H:%M:%S",
    "%d-%b-%Y %H:%M",
    "%d-%b-%Y",
    "%d-%m-%Y",
    "%Y-%m-%d",
    "%d/%m/%Y",
)


def parse_date(raw: Any) -> str | None:
    """Return an ISO date (YYYY-MM-DD) or None for NSE's many date formats."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text in {"-", "NA", "Nil"}:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_number(raw: Any) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).replace(",", "").strip()
    if not text or text in {"-", "NA", "Nil"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _pick(record: dict, canonical: str) -> Any:
    for name in FIELD_ALIASES[canonical]:
        if name in record and record[name] not in (None, ""):
            return record[name]
    return None


def parse_record(record: dict) -> dict | None:
    """Map one raw NSE record to the canonical trade dict (None if unusable)."""
    symbol = _pick(record, "symbol")
    if not symbol:
        return None
    out = {
        "symbol": str(symbol).strip().upper(),
        "company": _str(_pick(record, "company")),
        "person": _str(_pick(record, "person")),
        "category": _str(_pick(record, "category")),
        "security_type": _str(_pick(record, "security_type")),
        "quantity": parse_number(_pick(record, "quantity")),
        "value": parse_number(_pick(record, "value")),
        "txn_type": _str(_pick(record, "txn_type")),
        "mode": _str(_pick(record, "mode")),
        "holding_before_pct": parse_number(_pick(record, "holding_before_pct")),
        "holding_after_pct": parse_number(_pick(record, "holding_after_pct")),
        "trade_from": parse_date(_pick(record, "trade_from")),
        "trade_to": parse_date(_pick(record, "trade_to")),
        "intimation_date": parse_date(_pick(record, "intimation_date")),
        "disclosure_date": parse_date(_pick(record, "disclosure_date")),
    }
    return _fill_disclosure_date(out)


def _fill_disclosure_date(trade: dict) -> dict | None:
    """Fall back to an earlier date when the disclosure date is missing and flag it.

    The fallback is before the public saw the filing, so returns measured from it
    would be look-ahead; analysis skips returns for flagged rows.
    """
    trade["disclosure_estimated"] = 0
    if trade["disclosure_date"] is None:
        trade["disclosure_date"] = trade["intimation_date"] or trade["trade_to"]
        trade["disclosure_estimated"] = 1
    return trade if trade["disclosure_date"] is not None else None


def _str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def parse_response(payload: Any) -> list[dict]:
    """Parse a corporates-pit response body ({"data": [...]} or a bare list)."""
    rows = payload.get("data", []) if isinstance(payload, dict) else payload
    parsed = (parse_record(r) for r in rows or [] if isinstance(r, dict))
    return [p for p in parsed if p is not None]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _pct(raw: Any) -> float | None:
    # XBRL stores shareholding as a fraction (0.0102); the rest of the app uses 1.02.
    # A few filers type the percentage itself; a fraction can't exceed 1, so keep those.
    value = parse_number(raw)
    if value is None:
        return None
    return round(value if value > 1 else value * 100, 4)


def parse_xbrl(xml: str | bytes, disclosure_date: str | None = None) -> list[dict]:
    """Parse one PIT XBRL filing (one trade per disclosure context).

    Pass the raw bytes when you have them so the parser honours the file's own
    encoding declaration.
    """
    root = ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    contexts: dict[str, dict[str, str]] = {}
    for el in root:
        ctx = el.get("contextRef")
        if ctx and el.text is not None:
            contexts.setdefault(ctx, {})[_local(el.tag)] = el.text.strip()
    main = contexts.pop("MainI", {})
    symbol = main.get("Symbol", "").strip().upper()
    filed = disclosure_date or parse_date(main.get("DateOfFiling"))
    if not symbol:
        return []
    trades = []
    for fields in contexts.values():
        if "NameOfThePerson" not in fields:
            continue
        instrument = fields.get("TypeOfInstrument", "")
        trade = {
            "symbol": symbol,
            "company": main.get("NameOfTheCompany", ""),
            "person": fields.get("NameOfThePerson", ""),
            "category": fields.get("CategoryOfPerson", ""),
            "security_type": "Equity Shares" if instrument == "Equity" else instrument,
            "quantity": parse_number(fields.get("SecuritiesAcquiredOrDisposedNumberOfSecurity")),
            "value": parse_number(fields.get("SecuritiesAcquiredOrDisposedValueOfSecurity")),
            "txn_type": fields.get("SecuritiesAcquiredOrDisposedTransactionType", ""),
            "mode": fields.get("ModeOfAcquisitionOrDisposal", ""),
            "holding_before_pct": _pct(fields.get(
                "SecuritiesHeldPriorToAcquisitionOrDisposalPercentageOfShareholding")),
            "holding_after_pct": _pct(fields.get(
                "SecuritiesHeldPostAcquistionOrDisposalPercentageOfShareholding")),
            "trade_from": parse_date(fields.get(
                "DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyFromDate")),
            "trade_to": parse_date(fields.get(
                "DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyToDate")),
            "intimation_date": parse_date(fields.get("DateOfIntimationToCompany")),
            "disclosure_date": filed,
        }
        if _fill_disclosure_date(trade) is not None:
            trades.append(trade)
    return trades


def filing_id(symbol: Any, app_id: Any) -> str:
    return f"{symbol}:{app_id}"


def superseded_filings(filings: list[dict]) -> set[str]:
    """filing_id of originals that a revision in the same listing replaces."""
    return {filing_id(f.get("symbol"), f["prevAppId"]) for f in filings
            if f.get("prevAppId") not in (None, "")}


def date_chunks(start: date, end: date, days: int = CHUNK_DAYS) -> Iterable[tuple[date, date]]:
    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=days - 1), end)
        yield cur, chunk_end
        cur = chunk_end + timedelta(days=1)


class NSEClient:
    def __init__(self, pause: float = 1.5, retries: int = 3, timeout: float = 20,
                 progress: Callable[[str], None] = lambda msg: None):
        self.pause = pause
        self.retries = retries
        self.timeout = timeout
        self.progress = progress
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._primed = False
        # Listing entries whose XBRL file could not be downloaded in the last
        # fetch_pit / retry_filings call; pass them to retry_filings later.
        self.failed_filings: list[dict] = []
        self._lock = threading.Lock()
        self._blocked_until = 0.0
        # requests.Session isn't thread-safe, so each download worker gets its own.
        self._local = threading.local()

    def _worker_session(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update(HEADERS)
            with self._lock:
                session.cookies.update(self.session.cookies)
            self._local.session = session
        return session

    def _prime(self) -> None:
        # The API returns 401/403 unless the homepage cookies are present.
        self.session.get(BASE_URL, timeout=self.timeout)
        self.session.get(HEADERS["Referer"], timeout=self.timeout)
        self._primed = True

    def _get_json(self, url: str, params: dict) -> Any:
        last_err: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                if not self._primed:
                    self._prime()
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code in (401, 403):
                    self._primed = False
                    raise requests.HTTPError(f"NSE returned {resp.status_code}", response=resp)
                resp.raise_for_status()
                return resp.json()
            except (requests.RequestException, ValueError) as err:
                last_err = err
                log.warning("NSE request failed (attempt %d/%d): %s", attempt, self.retries, err)
                time.sleep(self.pause * attempt * 2)
        raise RuntimeError(f"NSE request failed after {self.retries} attempts: {last_err}")

    def _get_bytes(self, url: str) -> bytes:
        last_err: Exception | None = None
        for attempt in range(1, self.retries + 1):
            with self._lock:
                wait = self._blocked_until - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            try:
                resp = self._worker_session().get(url, timeout=self.timeout)
                if resp.status_code == 403:
                    with self._lock:
                        until = time.monotonic() + ARCHIVE_COOLDOWN * attempt
                        if until > self._blocked_until:
                            self._blocked_until = until
                            self.progress(f"  NSE is rate-limiting; pausing {ARCHIVE_COOLDOWN * attempt}s")
                resp.raise_for_status()
                time.sleep(self.pause / 5)
                return resp.content
            except requests.RequestException as err:
                last_err = err
                time.sleep(self.pause * attempt)
        raise RuntimeError(f"{url}: {last_err}")

    def fetch_pit(self, start: date, end: date, symbol: str | None = None,
                  on_chunk: Callable[[list[dict]], None] | None = None) -> list[dict]:
        """Fetch parsed PIT disclosures between start and end (inclusive).

        on_chunk receives each date chunk's trades as soon as they are parsed, so a
        caller can save progress before a later chunk fails.
        """
        self.failed_filings = []
        sink = _Sink(on_chunk)
        if start <= LEGACY_LAST_DAY:
            self._fetch_legacy(start, min(end, LEGACY_LAST_DAY), symbol, sink)
        if end > LEGACY_LAST_DAY:
            first_xbrl_day = LEGACY_LAST_DAY + timedelta(days=1)
            self._fetch_xbrl(max(start, first_xbrl_day), end, symbol, sink)
        return sink.trades

    def retry_filings(self, filings: list[dict]) -> list[dict]:
        """Download listing entries that failed before (from failed_filings)."""
        self.failed_filings = []
        return self._download(filings)

    def _params(self, chunk_start: date, chunk_end: date, symbol: str | None) -> dict:
        params = {
            "index": "equities",
            "from_date": chunk_start.strftime("%d-%m-%Y"),
            "to_date": chunk_end.strftime("%d-%m-%Y"),
        }
        if symbol:
            params["symbol"] = symbol.upper()
        return params

    def _fetch_legacy(self, start: date, end: date, symbol: str | None, sink: _Sink) -> None:
        for chunk_start, chunk_end in date_chunks(start, end):
            sink(parse_response(self._get_json(PIT_URL, self._params(chunk_start, chunk_end, symbol))))
            time.sleep(self.pause)

    def _fetch_xbrl(self, start: date, end: date, symbol: str | None, sink: _Sink) -> None:
        for chunk_start, chunk_end in date_chunks(start, end):
            payload = self._get_json(PIT_XBRL_URL, self._params(chunk_start, chunk_end, symbol))
            filings = payload.get("data", []) if isinstance(payload, dict) else payload or []
            replaced = superseded_filings(filings)
            filings = [f for f in filings if f.get("xmlFileName")
                       and filing_id(f.get("symbol"), f.get("appId")) not in replaced]
            self.progress(f"Downloading {len(filings)} filings ({chunk_start} → {chunk_end})")
            sink(self._download(filings))
            time.sleep(self.pause)

    def _download(self, filings: list[dict]) -> list[dict]:
        trades: list[dict] = []
        with ThreadPoolExecutor(XBRL_WORKERS) as pool:
            for i, parsed in enumerate(pool.map(self._fetch_filing, filings), 1):
                trades.extend(parsed)
                if i % 200 == 0:
                    self.progress(f"  {i}/{len(filings)} filings")
        return trades

    def _fetch_filing(self, filing: dict) -> list[dict]:
        url = filing["xmlFileName"]
        try:
            trades = parse_xbrl(self._get_bytes(url), parse_date(filing.get("broadcastDateTime")))
        except Exception as err:  # one bad filing must not abort the whole download
            log.warning("Skipping filing %s: %s", url, err)
            with self._lock:
                self.failed_filings.append(filing)
            return []
        # Tag trades with their filing so a later revision can replace them.
        fid = filing_id(filing.get("symbol"), filing.get("appId"))
        prev = filing.get("prevAppId")
        for t in trades:
            t["filing_id"] = fid
            if prev not in (None, ""):
                t["replaces"] = filing_id(filing.get("symbol"), prev)
        return trades


class _Sink:
    """Collects trades and forwards each chunk to an optional callback."""

    def __init__(self, on_chunk: Callable[[list[dict]], None] | None):
        self.on_chunk = on_chunk
        self.trades: list[dict] = []

    def __call__(self, chunk: list[dict]) -> None:
        self.trades.extend(chunk)
        if self.on_chunk is not None:
            self.on_chunk(chunk)
