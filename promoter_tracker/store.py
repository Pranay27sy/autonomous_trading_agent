"""SQLite cache for disclosures and daily prices."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .config import DEFAULT_DB

# How long a write waits for another process (the scheduled refresh vs the app)
# to release the database before failing with "database is locked".
BUSY_TIMEOUT_S = 30

# Daily bar columns besides close; NULL for bars cached before candles were stored.
OHLC_EXTRA = ("open", "high", "low", "volume")

TRADE_COLUMNS = [
    "symbol", "company", "person", "category", "security_type", "quantity", "value",
    "txn_type", "mode", "holding_before_pct", "holding_after_pct", "trade_from",
    "trade_to", "intimation_date", "disclosure_date",
    # "<symbol>:<appId>" of the XBRL filing (NULL for legacy rows), so a revision can
    # replace it; 1 when disclosure_date is a fallback from an earlier date.
    "filing_id", "disclosure_estimated",
]
_COLUMN_TYPES = {"quantity": "REAL", "value": "REAL", "holding_before_pct": "REAL",
                 "holding_after_pct": "REAL", "disclosure_estimated": "INTEGER"}
# Fields that identify a disclosure; the same filing re-fetched gets the same key.
_KEY_FIELDS = ("symbol", "person", "disclosure_date", "trade_from", "trade_to",
               "quantity", "txn_type", "mode", "security_type")

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS trades (
    trade_key TEXT PRIMARY KEY,
    {", ".join(f"{c} {_COLUMN_TYPES.get(c, 'TEXT')}" for c in TRADE_COLUMNS)}
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_disclosure ON trades(disclosure_date);
CREATE TABLE IF NOT EXISTS superseded_filings (
    filing_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS prices (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    volume REAL,
    PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS watchlist (
    symbol TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,          -- watchlist | conviction | big_buy | big_sell | cluster | pledge
    dedup_key TEXT NOT NULL,     -- trade_key, or symbol:start for clusters
    symbol TEXT NOT NULL,
    company TEXT,
    direction TEXT,
    value REAL,
    event_date TEXT,
    title TEXT NOT NULL,
    detail TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    notified_at TEXT,
    UNIQUE (kind, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE TABLE IF NOT EXISTS company_info (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    sector TEXT,
    industry TEXT,
    market_cap REAL,           -- INR, as of updated_at
    shares_outstanding REAL,
    updated_at TEXT NOT NULL   -- also set when the lookup failed, so it isn't retried daily
);
"""


def trade_key(trade: dict) -> str:
    raw = "|".join(str(trade.get(f) or "") for f in _KEY_FIELDS)
    # A dedup key, not a security boundary; changing the hash would orphan stored rows.
    return hashlib.sha1(raw.encode(), usedforsecurity=False).hexdigest()


class Store:
    """One SQLite connection shared by the app's sessions; every call holds a lock.

    The app and the scheduled refresh are separate processes writing the same
    file, so the database runs in WAL mode (readers never block the writer) and
    writes wait out the other process instead of failing straight away.
    """

    def __init__(self, path: Path | str = DEFAULT_DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, timeout=BUSY_TIMEOUT_S)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")  # durable enough with WAL, much faster
        self.conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        # Databases created before a column existed get it added (as NULL).
        have = {row[1] for row in self.conn.execute("PRAGMA table_info(trades)")}
        for col in TRADE_COLUMNS:
            if col not in have:
                self.conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {_COLUMN_TYPES.get(col, 'TEXT')}")
        if "first_seen" not in have:  # when this database first stored the row (alerts)
            self.conn.execute("ALTER TABLE trades ADD COLUMN first_seen TEXT")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_filing ON trades(filing_id)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_first_seen ON trades(first_seen)")
        have = {row[1] for row in self.conn.execute("PRAGMA table_info(prices)")}
        for col in OHLC_EXTRA:
            if col not in have:
                self.conn.execute(f"ALTER TABLE prices ADD COLUMN {col} REAL")
        self.conn.commit()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    # --- trades -----------------------------------------------------------
    def upsert_trades(self, trades: list[dict]) -> int:
        """Insert new trades, ignoring ones already stored. Returns rows added.

        A trade carrying "replaces" (a revised filing) deletes the original
        filing's rows and keeps that original from being inserted again later.
        """
        replaced = sorted({t["replaces"] for t in trades if t.get("replaces")})
        with self._lock, self.conn:  # one transaction: all or nothing
            if replaced:
                self.conn.executemany("INSERT OR IGNORE INTO superseded_filings VALUES (?)",
                                      [(r,) for r in replaced])
                self.conn.executemany("DELETE FROM trades WHERE filing_id = ?",
                                      [(r,) for r in replaced])
            dead = self._superseded({t["filing_id"] for t in trades if t.get("filing_id")})
            seen = _now_precise()
            rows = [(trade_key(t), *(t.get(c) for c in TRADE_COLUMNS), seen)
                    for t in trades if t.get("filing_id") not in dead]
            before = self._count_trades()
            # Rows stored before filing_id existed pick it up when re-fetched.
            self.conn.executemany(
                f"INSERT INTO trades (trade_key, {', '.join(TRADE_COLUMNS)}, first_seen) "  # noqa: S608 (constant column names)
                f"VALUES ({', '.join('?' * (len(TRADE_COLUMNS) + 2))}) "
                "ON CONFLICT(trade_key) DO UPDATE SET "
                "filing_id = COALESCE(trades.filing_id, excluded.filing_id)",
                rows,
            )
            added = self._count_trades() - before
        return added

    def _count_trades(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]

    def _superseded(self, filing_ids: set[str]) -> set[str]:
        if not filing_ids:
            return set()
        ids = sorted(filing_ids)
        found = set()
        for i in range(0, len(ids), 500):  # stay under SQLite's variable limit
            part = ids[i:i + 500]
            found.update(r[0] for r in self.conn.execute(
                f"SELECT filing_id FROM superseded_filings WHERE filing_id IN "  # noqa: S608 (placeholders only)
                f"({', '.join('?' * len(part))})", part))
        return found

    def load_trades(self, seen_after: str | None = None) -> pd.DataFrame:
        """All trades, or only those first stored after the ISO time seen_after."""
        with self._lock:
            if seen_after is None:
                df = pd.read_sql_query("SELECT * FROM trades", self.conn)
            else:
                df = pd.read_sql_query("SELECT * FROM trades WHERE first_seen > ?", self.conn,
                                       params=(seen_after,))
        for col in ("trade_from", "trade_to", "intimation_date", "disclosure_date"):
            df[col] = pd.to_datetime(df[col], errors="coerce")
        df["disclosure_estimated"] = df["disclosure_estimated"].fillna(0).astype(bool)
        return df

    def last_disclosure_date(self) -> str | None:
        # Estimated dates come from filer-typed fields; a typo like 2062 must not
        # push the next refresh window into the future.
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(disclosure_date) FROM trades WHERE NOT COALESCE(disclosure_estimated, 0)"
            ).fetchone()
        return row[0] if row else None

    # --- prices -----------------------------------------------------------
    def upsert_prices(self, ticker: str, bars: pd.Series | pd.DataFrame,
                      replace: bool = False) -> int:
        """Store daily bars: a DataFrame with close (+ open/high/low/volume), or closes alone.

        replace=True swaps out the ticker's whole history, so bars on dates the new
        download no longer has (e.g. old holiday bars) don't linger.
        """
        df = bars.to_frame("close") if isinstance(bars, pd.Series) else bars
        df = df.dropna(subset=["close"])
        rows = [(ticker, pd.Timestamp(d).date().isoformat(), float(r["close"]),
                 *(_num(r.get(c)) for c in OHLC_EXTRA))
                for d, r in df.iterrows()]
        with self._lock, self.conn:
            if replace:
                self.conn.execute("DELETE FROM prices WHERE ticker = ?", (ticker,))
            before = self.conn.total_changes
            self.conn.executemany(
                "INSERT OR REPLACE INTO prices (ticker, date, close, open, high, low, volume) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            return self.conn.total_changes - before

    def load_prices(self, ticker: str) -> pd.Series:
        with self._lock:
            df = pd.read_sql_query(
                "SELECT date, close FROM prices WHERE ticker = ? ORDER BY date",
                self.conn, params=(ticker,),
            )
        return pd.Series(df["close"].to_numpy(), index=pd.to_datetime(df["date"]), name=ticker)

    def load_bars(self, ticker: str) -> pd.DataFrame:
        """Daily open/high/low/close/volume indexed by date (OHLC may be NaN on old rows)."""
        with self._lock:
            df = pd.read_sql_query(
                "SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ? "
                "ORDER BY date", self.conn, params=(ticker,))
        return df.set_index(pd.to_datetime(df.pop("date")))

    def missing_ohlc(self, ticker: str) -> bool:
        """True if some cached bars only have a close (cached before candles were stored)."""
        with self._lock:
            row = self.conn.execute(
                "SELECT EXISTS (SELECT 1 FROM prices WHERE ticker = ? AND open IS NULL)",
                (ticker,)).fetchone()
        return bool(row[0])

    def last_price_date(self, ticker: str) -> str | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(date) FROM prices WHERE ticker = ?", (ticker,)
            ).fetchone()
        return row[0] if row else None

    def max_first_seen(self) -> str | None:
        with self._lock:
            return self.conn.execute("SELECT MAX(first_seen) FROM trades").fetchone()[0]

    # --- watchlist ----------------------------------------------------------
    def watchlist(self) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT symbol, added_at FROM watchlist ORDER BY symbol").fetchall()
        return [{"symbol": s, "added_at": a} for s, a in rows]

    def watch(self, symbol: str) -> bool:
        """Add to the watchlist; False if it was already there."""
        with self._lock, self.conn:
            cur = self.conn.execute("INSERT OR IGNORE INTO watchlist VALUES (?, ?)",
                                    (symbol, _now()))
        return cur.rowcount == 1

    def unwatch(self, symbol: str) -> bool:
        with self._lock, self.conn:
            cur = self.conn.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol,))
        return cur.rowcount == 1

    # --- alerts -------------------------------------------------------------
    ALERT_FIELDS = ("kind", "dedup_key", "symbol", "company", "direction", "value",
                    "event_date", "title", "detail")

    def add_alerts(self, alerts: list[dict]) -> list[dict]:
        """Store alerts, skipping any already raised (same kind + dedup_key).

        Returns the ones actually added, with id and created_at.
        """
        added = []
        with self._lock, self.conn:
            for a in alerts:
                created = _now()
                cur = self.conn.execute(
                    f"INSERT OR IGNORE INTO alerts (created_at, {', '.join(self.ALERT_FIELDS)}) "  # noqa: S608 (constant column names)
                    f"VALUES (?, {', '.join('?' * len(self.ALERT_FIELDS))})",
                    (created, *(a.get(f) for f in self.ALERT_FIELDS)))
                if cur.rowcount == 1:
                    added.append({**a, "id": cur.lastrowid, "created_at": created, "read": False})
        return added

    def alerts(self, limit: int = 100, unread_only: bool = False) -> list[dict]:
        where = "WHERE read = 0" if unread_only else ""
        with self._lock:
            cur = self.conn.execute(
                f"SELECT * FROM alerts {where} ORDER BY id DESC LIMIT ?", (limit,))  # noqa: S608 (constant clause)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
        for r in rows:
            r["read"] = bool(r["read"])
        return rows

    def unread_alerts(self) -> int:
        with self._lock:
            return self.conn.execute("SELECT COUNT(*) FROM alerts WHERE read = 0").fetchone()[0]

    def mark_alerts_read(self, ids: list[int] | None = None) -> int:
        """Mark the given alerts (or all of them) read."""
        with self._lock, self.conn:
            if ids is None:
                return self.conn.execute("UPDATE alerts SET read = 1 WHERE read = 0").rowcount
            return self.conn.executemany("UPDATE alerts SET read = 1 WHERE id = ?",
                                         [(i,) for i in ids]).rowcount

    def mark_alerts_notified(self, ids: list[int]) -> None:
        with self._lock, self.conn:
            self.conn.executemany("UPDATE alerts SET notified_at = ? WHERE id = ?",
                                  [(_now(), i) for i in ids])

    # --- company info -------------------------------------------------------
    COMPANY_FIELDS = ("name", "sector", "industry", "market_cap", "shares_outstanding")

    def upsert_company_info(self, symbol: str, info: dict) -> None:
        with self._lock, self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO company_info (symbol, name, sector, industry, market_cap, "
                "shares_outstanding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (symbol, *(info.get(f) for f in self.COMPANY_FIELDS), _now()))

    def company_info(self) -> pd.DataFrame:
        """Sector, industry and market cap per symbol (index: symbol)."""
        with self._lock:
            df = pd.read_sql_query("SELECT * FROM company_info", self.conn)
        return df.set_index("symbol")

    def company_info_age(self) -> dict[str, str]:
        """symbol -> updated_at, for deciding what to look up again."""
        with self._lock:
            return dict(self.conn.execute("SELECT symbol, updated_at FROM company_info"))

    # --- meta -------------------------------------------------------------
    def set_meta(self, key: str, value: str) -> None:
        with self._lock, self.conn:
            self.conn.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, value))

    def get_meta(self, key: str) -> str | None:
        with self._lock:
            row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def mark_refreshed(self) -> None:
        self.set_meta("last_refresh", _now())

    def mark_refresh_attempt(self) -> None:
        self.set_meta("last_refresh_attempt", _now())

    def failed_filings(self) -> list[dict]:
        """NSE listing entries whose XBRL download failed; retried on the next refresh."""
        return json.loads(self.get_meta("failed_filings") or "[]")

    def set_failed_filings(self, filings: list[dict]) -> None:
        unique = {f["xmlFileName"]: f for f in filings}
        self.set_meta("failed_filings", json.dumps(list(unique.values())))


def _num(value) -> float | None:
    return None if value is None or pd.isna(value) else float(value)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _now_precise() -> str:
    # Microseconds, so two refreshes in the same second still order correctly.
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")
