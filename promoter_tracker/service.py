"""What the API serves: filtering events and shaping them into JSON-ready dicts.

Everything here is plain pandas, independent of the web framework.
"""
from __future__ import annotations

import math
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd

from . import analysis, companies, conviction
from .prices import BENCHMARK, nse_ticker
from .store import Store

PERIODS: dict[str, int | None] = {"1M": 30, "3M": 91, "6M": 182, "1Y": 365, "3Y": 1095,
                                  "All": None}
SIGNAL_HORIZON = 60
_BAR_FIELDS = ("open", "high", "low", "close", "volume")

# Columns sent for each trade row; returns are fractions (0.05 = +5%).
TRADE_FIELDS = ["event_date", "symbol", "company", "person", "category", "direction", "mode",
                "quantity", "value", "holding_before_pct", "holding_after_pct",
                "holding_change_pct", "disclosure_date", "trade_to", "internal_transfer",
                "sector", "cap_bucket", "conviction", "conviction_reasons",
                *[f"ret_{h}" for h in analysis.HORIZONS], *[f"exc_{h}" for h in analysis.HORIZONS]]


@dataclass(frozen=True)
class Filters:
    period: str = "1Y"
    sides: tuple[str, ...] = ("buy", "sell")
    min_value: float = 1e6
    market_only: bool = True
    basis: str = "disclosure_date"
    # Leave out promoter-group members trading with each other (analysis.internal_transfers).
    exclude_transfers: bool = True


class EventCache:
    """Promoter events with forward returns, recomputed only after a refresh.

    Computing returns reads every stock's prices, so the result is cached per
    (market_only, basis), keyed by the last refresh time so a refresh made by
    another process (the scheduled CLI) is picked up.
    """

    def __init__(self, store: Store, max_entries: int = 4):
        self.store = store
        self.max_entries = max_entries
        self._cache: OrderedDict[tuple, pd.DataFrame] = OrderedDict()
        self._lock = threading.Lock()

    def version(self) -> str:
        return self.store.get_meta("last_refresh") or ""

    def get(self, market_only: bool, basis: str) -> pd.DataFrame:
        key = (market_only, basis, self.version())
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            events = analysis.promoter_events(self.store.load_trades(), market_only, basis)
            if not events.empty:
                events = analysis.event_returns(
                    events, lambda s: self.store.load_prices(nse_ticker(s)),
                    self.store.load_prices(BENCHMARK))
            events = companies.with_company_info(events, self.store.company_info())
            if not events.empty:
                events = conviction.add_conviction(
                    events, lambda s: self.store.load_bars(nse_ticker(s)))
            self._cache[key] = events
            while len(self._cache) > self.max_entries:
                self._cache.popitem(last=False)
            return events


def filter_events(events: pd.DataFrame, f: Filters) -> pd.DataFrame:
    if events.empty:
        return events
    keep = events["direction"].isin(f.sides) & (events["value"].fillna(0) >= f.min_value)
    if f.exclude_transfers:
        keep &= ~events["internal_transfer"]
    days = PERIODS[f.period]
    if days is not None:
        keep &= events["event_date"] >= events["event_date"].max() - pd.Timedelta(days=days)
    return events[keep]


# --- JSON helpers -------------------------------------------------------------
def clean(value: Any) -> Any:
    """Make a value JSON-safe: NaN/NaT -> None, numpy -> Python, dates -> ISO."""
    if value is None or value is pd.NaT or value is pd.NA:
        return None
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return value.date().isoformat() if isinstance(value, (pd.Timestamp, datetime)) \
            else value.isoformat()
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def clean_tree(obj: Any) -> Any:
    """clean() applied through nested dicts and lists."""
    if isinstance(obj, dict):
        return {k: clean_tree(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_tree(v) for v in obj]
    return clean(obj)


def records(df: pd.DataFrame, fields: list[str]) -> list[dict]:
    cols = [c for c in fields if c in df.columns]
    return [{c: clean(v) for c, v in zip(cols, row, strict=True)}
            for row in df[cols].itertuples(index=False, name=None)]


def weekly(view: pd.DataFrame, weeks: int) -> list[dict]:
    """₹ value bought, sold and net per week, the last `weeks` weeks (for sparklines)."""
    if view.empty:
        return []
    idx = view.set_index("event_date")
    buy = idx.loc[idx["direction"] == "buy", "value"].fillna(0).resample("W").sum()
    sell = idx.loc[idx["direction"] == "sell", "value"].fillna(0).resample("W").sum()
    end = view["event_date"].max() + pd.offsets.Week(weekday=6, n=0)  # that week's Sunday
    full = pd.date_range(end=end.normalize(), periods=weeks, freq="W")
    buy, sell = buy.reindex(full, fill_value=0), sell.reindex(full, fill_value=0)
    return [{"week": d.date().isoformat(), "buy": float(b), "sell": float(s),
             "net": float(b - s)} for d, b, s in zip(full, buy, sell, strict=True)]


def sparkline_weeks(period: str) -> int:
    days = PERIODS[period]
    return 52 if days is None else int(min(52, max(4, days // 7)))


# --- payloads -------------------------------------------------------------------
def overview(view: pd.DataFrame, f: Filters, min_people: int = 2, window_days: int = 30) -> dict:
    buys = view[view["direction"] == "buy"] if not view.empty else view
    sells = view[view["direction"] == "sell"] if not view.empty else view
    summary = analysis.summarize(view) if not view.empty else pd.DataFrame()
    lb = analysis.leaderboard(view)
    cl = analysis.clusters(view, min_people, window_days) if not view.empty else pd.DataFrame(
        columns=["symbol", "company", "start", "end", "promoters", "total_value"])
    return {
        "range": {"from": clean(view["event_date"].min()) if not view.empty else None,
                  "to": clean(view["event_date"].max()) if not view.empty else None},
        "kpis": {
            "trades": len(view),
            "stocks": int(view["symbol"].nunique()) if not view.empty else 0,
            "stocks_bought": int(buys["symbol"].nunique()) if not view.empty else 0,
            "buy_value": float(buys["value"].sum()) if not view.empty else 0.0,
            "buy_count": len(buys),
            "sell_value": float(sells["value"].sum()) if not view.empty else 0.0,
            "sell_count": len(sells),
            "net_value": float(view["signed_value"].sum()) if not view.empty else 0.0,
        },
        "weekly": weekly(view, sparkline_weeks(f.period)),
        "signal_horizon": SIGNAL_HORIZON,
        "summary": records(summary, ["direction", "horizon_days", "events", "mean_return",
                                     "median_return", "mean_excess", "hit_rate"]),
        "clusters": records(cl, ["symbol", "company", "start", "end", "promoters",
                                 "total_value"]),
        "top_buyers": records(lb[lb["net_value"] > 0].head(10),
                              ["symbol", "company", "net_value", "buys", "sells"]),
        "top_sellers": records(lb[lb["net_value"] < 0].tail(10).iloc[::-1],
                               ["symbol", "company", "net_value", "buys", "sells"]),
        "top_conviction": records(top_conviction(view), TRADE_FIELDS),
    }


def top_conviction(view: pd.DataFrame, n: int = 8) -> pd.DataFrame:
    """The highest-conviction buys in the view, newest first among equals."""
    if view.empty or "conviction" not in view:
        return view.head(0)
    buys = view[view["conviction"].notna()]
    return buys.sort_values(["conviction", "event_date"], ascending=False).head(n)


def trades(view: pd.DataFrame, query: str | None = None) -> dict:
    if query and not view.empty:
        q = query.strip().lower()
        hay = (view["symbol"] + " " + view["company"].fillna("") + " "
               + view["person"].fillna("")).str.lower()
        view = view[hay.str.contains(q, regex=False)]
    return {"total": len(view), "rows": records(view, TRADE_FIELDS)}


def stock_list(events: pd.DataFrame, view: pd.DataFrame) -> list[dict]:
    """Every stock with promoter trades; `trades` counts those matching the filters."""
    if events.empty:
        return []
    active = view.groupby("symbol").size() if not view.empty else pd.Series(dtype=int)
    firsts = events.drop_duplicates("symbol").set_index("symbol")["company"]
    out = [{"symbol": s, "company": clean(firsts[s]), "trades": int(active.get(s, 0))}
           for s in firsts.index]
    return sorted(out, key=lambda r: (-r["trades"], r["symbol"]))


def stock(events: pd.DataFrame, symbol: str, sides: tuple[str, ...], bars: pd.DataFrame,
          exclude_transfers: bool = True) -> dict:
    """bars: daily open/high/low/close/volume (Store.load_bars)."""
    prices = bars["close"]
    sev = events[(events["symbol"] == symbol) & events["direction"].isin(sides)]
    if exclude_transfers:
        sev = sev[~sev["internal_transfer"]]
    buys = sev[sev["direction"] == "buy"]
    after = buys["exc_60"].dropna() if "exc_60" in buys else pd.Series(dtype=float)
    hold = sev.dropna(subset=["holding_after_pct"]).sort_values("event_date")
    last = prices.iloc[-1] if len(prices) else None
    year_ago = prices.asof(prices.index[-1] - pd.Timedelta(days=365)) if len(prices) else None
    first = events.loc[events["symbol"] == symbol].iloc[0]
    return {
        "symbol": symbol,
        "company": clean(first["company"]),
        "sector": clean(first.get("sector")),
        "industry": clean(first.get("industry")),
        "market_cap": clean(first.get("market_cap")),
        "cap_bucket": clean(first.get("cap_bucket")),
        "kpis": {
            "last_close": clean(last),
            "last_date": clean(prices.index[-1]) if len(prices) else None,
            "change_1y": clean(last / year_ago - 1) if last is not None and pd.notna(year_ago)
            else None,
            "net_value": float(sev["signed_value"].sum()),
            "buys": len(buys),
            "sells": len(sev) - len(buys),
            "last_holding_pct": clean(hold["holding_after_pct"].iloc[-1]) if len(hold) else None,
            "after_buys_exc_60": clean(after.mean()) if len(after) else None,
            "after_buys_hit_60": clean((after > 0).mean()) if len(after) else None,
            "after_buys_n": len(after),
        },
        # Bars cached before candles were stored have only a close (open etc. null).
        "prices": [{"time": d.date().isoformat(),
                    **{c: None if pd.isna(v) else round(float(v), 4)
                       for c, v in zip(_BAR_FIELDS, row, strict=True)}}
                   for d, row in zip(bars.index, bars[list(_BAR_FIELDS)].itertuples(
                       index=False, name=None), strict=True)],
        "trades": records(sev, TRADE_FIELDS),
    }


def watchlist(events: pd.DataFrame, watched: list[dict], sides: tuple[str, ...],
              closes) -> list[dict]:
    """Each watched stock with its latest promoter trade, recent flow and price.

    closes(symbol) -> pd.Series of daily closes.
    """
    out = []
    end = events["event_date"].max() if not events.empty else None
    for w in watched:
        sym = w["symbol"]
        sev = events[(events["symbol"] == sym) & events["direction"].isin(sides)] \
            if not events.empty else events
        recent = sev[sev["event_date"] >= end - pd.Timedelta(days=90)] if len(sev) else sev
        last = sev.sort_values("event_date").iloc[-1] if len(sev) else None
        px = closes(sym)
        month_ago = px.asof(px.index[-1] - pd.Timedelta(days=30)) if len(px) else None
        out.append({
            "symbol": sym,
            "company": clean(sev["company"].iloc[0]) if len(sev) else None,
            "added_at": w["added_at"],
            "last_trade": None if last is None else {
                "event_date": clean(last["event_date"]), "direction": last["direction"],
                "value": clean(last["value"]), "person": clean(last["person"])},
            "net_value_90d": float(recent["signed_value"].sum()) if len(recent) else 0.0,
            "trades_90d": len(recent),
            "last_close": clean(px.iloc[-1]) if len(px) else None,
            "change_1m": clean(px.iloc[-1] / month_ago - 1)
            if len(px) and month_ago is not None and pd.notna(month_ago) else None,
        })
    return out


def _flow(group: pd.DataFrame) -> dict:
    buys = group[group["direction"] == "buy"]
    sells = group[group["direction"] == "sell"]
    net_by_stock = group.groupby("symbol")["signed_value"].sum()
    return {
        "buy_value": float(buys["value"].sum()),
        "sell_value": float(sells["value"].sum()),
        "net_value": float(group["signed_value"].sum()),
        "trades": len(group),
        "stocks": int(group["symbol"].nunique()),
        "stocks_net_buying": int((net_by_stock > 0).sum()),
        "top_buy": clean(net_by_stock.idxmax()) if len(net_by_stock) and net_by_stock.max() > 0
        else None,
    }


def sectors(view: pd.DataFrame) -> dict:
    """Promoter flow per sector and per market-cap bucket."""
    if view.empty:
        return {"sectors": [], "caps": [], "classified_share": None}
    v = view.assign(sector=view["sector"].fillna("Unclassified"),
                    cap_bucket=view["cap_bucket"].fillna("Unknown"))
    by_sector = [{"sector": k, **_flow(g)} for k, g in v.groupby("sector")]
    order = [b for b, _ in companies.BUCKETS] + ["Unknown"]
    by_cap = [{"bucket": k, **_flow(g)} for k, g in v.groupby("cap_bucket")]
    return {
        "sectors": sorted(by_sector, key=lambda r: -r["net_value"]),
        "caps": sorted(by_cap, key=lambda r: order.index(r["bucket"])),
        # Share of trades with a known sector; low until company info is loaded.
        "classified_share": float((v["sector"] != "Unclassified").mean()),
    }
