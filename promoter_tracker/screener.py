"""Screen stocks on promoter activity, price behaviour and pledge risk.

metrics() builds one row per stock with promoter trades in the look-back
window; screen() filters and sorts those rows by a Criteria. Saved screens can
alert when a stock newly matches (see alerts.screen_alerts).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from typing import Callable

import numpy as np
import pandas as pd

SORTS = ("net_value", "conviction", "below_high", "promoters", "change_3m")


@dataclass(frozen=True)
class Criteria:
    lookback_days: int = 90
    min_net_value: float | None = None       # ₹, buys minus sells in the window
    min_buys: int | None = None
    min_promoters: int | None = None         # distinct promoters buying in the window
    min_conviction: int | None = None        # best buy conviction in the window
    min_below_high: float | None = None      # 0.2 = at least 20% below the 52-week high
    max_change_3m: float | None = None       # e.g. 0 = price not up over 3 months
    sectors: tuple[str, ...] = ()
    caps: tuple[str, ...] = ()
    exclude_pledge_risk: bool = False        # drop stocks with a recent pledge invocation
    sort: str = "net_value"

    @classmethod
    def from_dict(cls, d: dict) -> Criteria:
        known = {f.name for f in fields(cls)}
        clean = {k: (tuple(v) if isinstance(v, list) else v) for k, v in d.items() if k in known}
        return cls(**clean)

    def to_dict(self) -> dict:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items()}


PRESETS: dict[str, Criteria] = {
    "Fresh clusters": Criteria(lookback_days=30, min_promoters=3, min_net_value=0, sort="promoters"),
    "High-conviction dips": Criteria(lookback_days=90, min_conviction=50, min_below_high=0.2,
                                     sort="conviction"),
    "Quiet accumulation": Criteria(lookback_days=180, min_buys=5, min_net_value=1e7,
                                   max_change_3m=0.05, sort="net_value"),
    "Big money, no pledge stress": Criteria(lookback_days=90, min_net_value=1e8,
                                            exclude_pledge_risk=True, sort="net_value"),
}


def metrics(events: pd.DataFrame, closes: Callable[[str], pd.Series], lookback_days: int,
            pledge_risk: dict[str, str] | None = None) -> pd.DataFrame:
    """One row per stock with promoter trades in the last lookback_days of data."""
    cols = ["symbol", "company", "sector", "cap_bucket", "net_value", "buys", "sells", "promoters",
            "conviction", "last_trade", "last_direction", "last_close", "change_1m", "change_3m",
            "below_high", "pledge_risk"]
    if events.empty:
        return pd.DataFrame(columns=cols)
    e = events[~events["internal_transfer"]] if "internal_transfer" in events else events
    end = e["event_date"].max()
    w = e[e["event_date"] >= end - pd.Timedelta(days=lookback_days)]
    rows = []
    for sym, g in w.groupby("symbol"):
        buys = g[g["direction"] == "buy"]
        px = closes(sym).dropna()
        last = px.iloc[-1] if len(px) else np.nan

        def change(days: int, px=px, last=last) -> float:
            if not len(px):
                return np.nan
            then = px.asof(px.index[-1] - pd.Timedelta(days=days))
            return last / then - 1 if pd.notna(then) and then else np.nan

        high = px[px.index >= px.index[-1] - pd.Timedelta(days=365)].max() if len(px) else np.nan
        latest = g.sort_values("event_date").iloc[-1]
        rows.append({
            "symbol": sym,
            "company": g["company"].iloc[0],
            "sector": g["sector"].iloc[0] if "sector" in g else None,
            "cap_bucket": g["cap_bucket"].iloc[0] if "cap_bucket" in g else None,
            "net_value": float(g["signed_value"].sum()),
            "buys": len(buys),
            "sells": len(g) - len(buys),
            "promoters": int(buys["person"].nunique()),
            "conviction": buys["conviction"].max() if "conviction" in buys and len(buys) else np.nan,
            "last_trade": latest["event_date"],
            "last_direction": latest["direction"],
            "last_close": last,
            "change_1m": change(30),
            "change_3m": change(91),
            "below_high": 1 - last / high if pd.notna(high) and high else np.nan,
            "pledge_risk": (pledge_risk or {}).get(sym),
        })
    return pd.DataFrame(rows, columns=cols)


def screen(rows: pd.DataFrame, c: Criteria, limit: int = 200) -> pd.DataFrame:
    """Rows matching every set criterion, sorted (missing values last)."""
    r = rows
    if r.empty:
        return r

    def at_least(col: str, v) -> None:
        nonlocal r
        if v is not None:
            r = r[r[col].astype(float).fillna(-np.inf) >= v]

    at_least("net_value", c.min_net_value)
    at_least("buys", c.min_buys)
    at_least("promoters", c.min_promoters)
    at_least("conviction", c.min_conviction)
    at_least("below_high", c.min_below_high)
    if c.max_change_3m is not None:
        r = r[r["change_3m"].astype(float).fillna(np.inf) <= c.max_change_3m]
    if c.sectors:
        r = r[r["sector"].isin(c.sectors)]
    if c.caps:
        r = r[r["cap_bucket"].isin(c.caps)]
    if c.exclude_pledge_risk:
        r = r[r["pledge_risk"] != "high"]
    sort = c.sort if c.sort in SORTS else "net_value"
    ascending = sort == "change_3m"  # weakest price first for that one
    return r.sort_values(sort, ascending=ascending, na_position="last").head(limit)
