"""SQLite cache for disclosures and daily prices."""
from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "promoter.db"

TRADE_COLUMNS = [
    "symbol", "company", "person", "category", "security_type", "quantity", "value",
    "txn_type", "mode", "holding_before_pct", "holding_after_pct", "trade_from",
    "trade_to", "intimation_date", "disclosure_date",
]
# Fields that identify a disclosure; the same filing re-fetched gets the same key.
_KEY_FIELDS = ("symbol", "person", "disclosure_date", "trade_from", "trade_to",
               "quantity", "txn_type", "mode", "security_type")

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS trades (
    trade_key TEXT PRIMARY KEY,
    {", ".join(f"{c} {'REAL' if c in ('quantity', 'value', 'holding_before_pct', 'holding_after_pct') else 'TEXT'}" for c in TRADE_COLUMNS)}
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_disclosure ON trades(disclosure_date);
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
    def __init__(self, path: Path | str = DEFAULT_DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # --- trades -----------------------------------------------------------
    def upsert_trades(self, trades: list[dict]) -> int:
        """Insert new trades, ignoring ones already stored. Returns rows added."""
        rows = [(trade_key(t), *(t.get(c) for c in TRADE_COLUMNS)) for t in trades]
        before = self.conn.total_changes
        self.conn.executemany(
            f"INSERT OR IGNORE INTO trades VALUES ({', '.join('?' * (len(TRADE_COLUMNS) + 1))})",
            rows,
        )
        self.conn.commit()
        return self.conn.total_changes - before

    def load_trades(self) -> pd.DataFrame:
        df = pd.read_sql_query("SELECT * FROM trades", self.conn)
        for col in ("trade_from", "trade_to", "intimation_date", "disclosure_date"):
            df[col] = pd.to_datetime(df[col], errors="coerce")
        return df

    def last_disclosure_date(self) -> str | None:
        row = self.conn.execute("SELECT MAX(disclosure_date) FROM trades").fetchone()
        return row[0] if row else None

    # --- prices -----------------------------------------------------------
    def upsert_prices(self, ticker: str, closes: pd.Series) -> int:
        rows = [(ticker, pd.Timestamp(d).date().isoformat(), float(v))
                for d, v in closes.dropna().items()]
        before = self.conn.total_changes
        self.conn.executemany("INSERT OR REPLACE INTO prices VALUES (?, ?, ?)", rows)
        self.conn.commit()
        return self.conn.total_changes - before

    def load_prices(self, ticker: str) -> pd.Series:
        df = pd.read_sql_query(
            "SELECT date, close FROM prices WHERE ticker = ? ORDER BY date",
            self.conn, params=(ticker,),
        )
        return pd.Series(df["close"].to_numpy(), index=pd.to_datetime(df["date"]), name=ticker)

    def last_price_date(self, ticker: str) -> str | None:
        row = self.conn.execute(
            "SELECT MAX(date) FROM prices WHERE ticker = ?", (ticker,)
        ).fetchone()
        return row[0] if row else None

    # --- meta -------------------------------------------------------------
    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, value))
        self.conn.commit()

    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def mark_refreshed(self) -> None:
        self.set_meta("last_refresh", datetime.now(timezone.utc).isoformat(timespec="seconds"))
