"""Fetch and parse SEBI PIT (insider trading) disclosures from NSE.

NSE serves this data through the same unofficial JSON API its website uses.
It needs browser-like headers and the cookies set by the homepage, and it
rate-limits aggressively, so requests are chunked and spaced out.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Iterable

import requests

log = logging.getLogger(__name__)

BASE_URL = "https://www.nseindia.com"
PIT_URL = f"{BASE_URL}/api/corporates-pit"
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
    if out["disclosure_date"] is None:
        out["disclosure_date"] = out["intimation_date"] or out["trade_to"]
    if out["disclosure_date"] is None:
        return None
    return out


def _str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def parse_response(payload: Any) -> list[dict]:
    """Parse a corporates-pit response body ({"data": [...]} or a bare list)."""
    rows = payload.get("data", []) if isinstance(payload, dict) else payload
    parsed = (parse_record(r) for r in rows or [] if isinstance(r, dict))
    return [p for p in parsed if p is not None]


def date_chunks(start: date, end: date, days: int = CHUNK_DAYS) -> Iterable[tuple[date, date]]:
    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=days - 1), end)
        yield cur, chunk_end
        cur = chunk_end + timedelta(days=1)


class NSEClient:
    def __init__(self, pause: float = 1.5, retries: int = 3, timeout: float = 20):
        self.pause = pause
        self.retries = retries
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._primed = False

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

    def fetch_pit(self, start: date, end: date, symbol: str | None = None) -> list[dict]:
        """Fetch parsed PIT disclosures between start and end (inclusive)."""
        trades: list[dict] = []
        for chunk_start, chunk_end in date_chunks(start, end):
            params = {
                "index": "equities",
                "from_date": chunk_start.strftime("%d-%m-%Y"),
                "to_date": chunk_end.strftime("%d-%m-%Y"),
            }
            if symbol:
                params["symbol"] = symbol.upper()
            trades.extend(parse_response(self._get_json(PIT_URL, params)))
            time.sleep(self.pause)
        return trades
