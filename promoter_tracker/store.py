"""SQLite cache for disclosures and daily prices."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "promoter.db"

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
    PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def trade_key(trade: dict) -> str:
    raw = "|".join(str(trade.get(f) or "") for f in _KEY_FIELDS)
    return hashlib.sha1(raw.encode()).hexdigest()


class Store:
    """One SQLite connection shared by the app's sessions; every call holds a lock."""

    def __init__(self, path: Path | str = DEFAULT_DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        # Databases created before a column existed get it added (as NULL).
        have = {row[1] for row in self.conn.execute("PRAGMA table_info(trades)")}
        for col in TRADE_COLUMNS:
            if col not in have:
                self.conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {_COLUMN_TYPES.get(col, 'TEXT')}")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_filing ON trades(filing_id)")
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
        with self._lock:
            if replaced:
                self.conn.executemany("INSERT OR IGNORE INTO superseded_filings VALUES (?)",
                                      [(r,) for r in replaced])
                self.conn.executemany("DELETE FROM trades WHERE filing_id = ?",
                                      [(r,) for r in replaced])
            dead = self._superseded({t["filing_id"] for t in trades if t.get("filing_id")})
            rows = [(trade_key(t), *(t.get(c) for c in TRADE_COLUMNS))
                    for t in trades if t.get("filing_id") not in dead]
            before = self._count_trades()
            # Rows stored before filing_id existed pick it up when re-fetched.
            self.conn.executemany(
                f"INSERT INTO trades (trade_key, {', '.join(TRADE_COLUMNS)}) "
                f"VALUES ({', '.join('?' * (len(TRADE_COLUMNS) + 1))}) "
                "ON CONFLICT(trade_key) DO UPDATE SET "
                "filing_id = COALESCE(trades.filing_id, excluded.filing_id)",
                rows,
            )
            added = self._count_trades() - before
            self.conn.commit()
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
                f"SELECT filing_id FROM superseded_filings WHERE filing_id IN "
                f"({', '.join('?' * len(part))})", part))
        return found

    def load_trades(self) -> pd.DataFrame:
        with self._lock:
            df = pd.read_sql_query("SELECT * FROM trades", self.conn)
        for col in ("trade_from", "trade_to", "intimation_date", "disclosure_date"):
            df[col] = pd.to_datetime(df[col], errors="coerce")
        df["disclosure_estimated"] = df["disclosure_estimated"].fillna(0).astype(bool)
        return df

    def last_disclosure_date(self) -> str | None:
        with self._lock:
            row = self.conn.execute("SELECT MAX(disclosure_date) FROM trades").fetchone()
        return row[0] if row else None

    # --- prices -----------------------------------------------------------
    def upsert_prices(self, ticker: str, closes: pd.Series) -> int:
        rows = [(ticker, pd.Timestamp(d).date().isoformat(), float(v))
                for d, v in closes.dropna().items()]
        with self._lock:
            before = self.conn.total_changes
            self.conn.executemany("INSERT OR REPLACE INTO prices VALUES (?, ?, ?)", rows)
            self.conn.commit()
            return self.conn.total_changes - before

    def load_prices(self, ticker: str) -> pd.Series:
        with self._lock:
            df = pd.read_sql_query(
                "SELECT date, close FROM prices WHERE ticker = ? ORDER BY date",
                self.conn, params=(ticker,),
            )
        return pd.Series(df["close"].to_numpy(), index=pd.to_datetime(df["date"]), name=ticker)

    def last_price_date(self, ticker: str) -> str | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(date) FROM prices WHERE ticker = ?", (ticker,)
            ).fetchone()
        return row[0] if row else None

    # --- meta -------------------------------------------------------------
    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self.conn.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, value))
            self.conn.commit()

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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
