"""Turn raw disclosures into promoter buy/sell events and measure what followed."""
from __future__ import annotations

import numpy as np
import pandas as pd

HORIZONS = (1, 5, 20, 60, 120)

_EXCLUDED_MODES = ("off market", "gift", "esop", "esos", "inter-se", "inter se",
                   "pledge", "invocation", "revocation", "transmission", "bonus",
                   "rights", "scheme", "conversion", "preferential", "allotment")


def is_promoter(category: str) -> bool:
    return "promoter" in (category or "").lower()


def trade_direction(txn_type: str, mode: str) -> str | None:
    """'buy', 'sell' or None (pledges, invocations and anything unclear)."""
    t = (txn_type or "").strip().lower()
    if t in ("buy", "acquisition", "purchase"):
        return "buy"
    if t in ("sell", "sale", "disposal"):
        return "sell"
    if t:  # Pledge, Revoke, Invoke, ...
        return None
    m = (mode or "").lower()
    if "purchase" in m or "acquisition" in m:
        return "buy"
    if "sale" in m or "sell" in m or "disposal" in m:
        return "sell"
    return None


def is_market_trade(mode: str) -> bool:
    m = (mode or "").lower()
    return "market" in m and not any(x in m for x in _EXCLUDED_MODES)


def promoter_events(trades: pd.DataFrame, market_only: bool = True,
                    event_date: str = "disclosure_date") -> pd.DataFrame:
    """Filter disclosures to promoter buys/sells and attach the event date.

    event_date is 'disclosure_date' (when the public could act) or 'trade_to'
    (when the promoter actually traded).
    """
    if trades.empty:
        return trades.assign(direction=pd.Series(dtype=str), event_date=pd.Series(dtype="datetime64[ns]"))
    df = trades[trades["category"].map(is_promoter)].copy()
    df["direction"] = [trade_direction(t, m) for t, m in zip(df["txn_type"], df["mode"])]
    df = df[df["direction"].notna()]
    if market_only:
        df = df[df["mode"].map(is_market_trade)]
    fallback = df["disclosure_date"] if event_date != "disclosure_date" else df["trade_to"]
    if event_date == "disclosure_date":
        # A filled-in disclosure date is earlier than the public saw the filing, so
        # returns measured from it would use information nobody could trade on.
        estimated = df.get("disclosure_estimated", pd.Series(False, index=df.index))
        df["returns_valid"] = ~(estimated.fillna(False).astype(bool) | df["disclosure_date"].isna())
    else:
        df["returns_valid"] = True
    df["event_date"] = df[event_date].fillna(fallback)
    df = df[df["event_date"].notna()]
    df["holding_change_pct"] = df["holding_after_pct"] - df["holding_before_pct"]
    df["signed_value"] = np.where(df["direction"] == "buy", 1, -1) * df["value"].fillna(0)
    return df.sort_values("event_date", ascending=False).reset_index(drop=True)


def forward_returns(prices: pd.Series, event_date: pd.Timestamp,
                    horizons=HORIZONS) -> dict[int, float]:
    """Returns from the close of the first trading day after event_date.

    Entering the day after is conservative: disclosures often land after the
    close, so the event-day close was not actually tradable.
    """
    prices = prices.dropna().sort_index()
    idx = prices.index.searchsorted(pd.Timestamp(event_date), side="right")
    out: dict[int, float] = {}
    for h in horizons:
        if idx + h < len(prices):
            out[h] = prices.iloc[idx + h] / prices.iloc[idx] - 1
        else:
            out[h] = np.nan
    return out


def event_returns(events: pd.DataFrame, price_lookup, benchmark: pd.Series | None,
                  horizons=HORIZONS) -> pd.DataFrame:
    """Add ret_{h} and exc_{h} (return minus benchmark) columns to events.

    Rows with returns_valid False (estimated disclosure dates) get NaN.

    price_lookup(symbol) -> pd.Series of closes (empty if unknown).
    """
    events = events.copy()
    cache: dict[str, pd.Series] = {}
    ret_rows, exc_rows = [], []
    valid = events["returns_valid"] if "returns_valid" in events else [True] * len(events)
    for sym, when, ok in zip(events["symbol"], events["event_date"], valid):
        if not ok:
            ret_rows.append({h: np.nan for h in horizons})
            exc_rows.append({h: np.nan for h in horizons})
            continue
        if sym not in cache:
            cache[sym] = price_lookup(sym)
        px = cache[sym]
        r = forward_returns(px, when, horizons) if len(px) else {h: np.nan for h in horizons}
        ret_rows.append(r)
        if benchmark is not None and len(benchmark) and len(px):
            b = _benchmark_returns(px, benchmark, when, horizons)
            exc_rows.append({h: r[h] - b[h] for h in horizons})
        else:
            exc_rows.append({h: np.nan for h in horizons})
    for h in horizons:
        events[f"ret_{h}"] = [row[h] for row in ret_rows]
        events[f"exc_{h}"] = [row[h] for row in exc_rows]
    return events


def _benchmark_returns(stock: pd.Series, bench: pd.Series, when, horizons) -> dict[int, float]:
    """Benchmark return over exactly the same dates as the stock's return."""
    stock = stock.dropna().sort_index()
    bench = bench.dropna().sort_index()
    idx = stock.index.searchsorted(pd.Timestamp(when), side="right")
    out = {}
    for h in horizons:
        if idx + h >= len(stock):
            out[h] = np.nan
            continue
        start, end = stock.index[idx], stock.index[idx + h]
        b0, b1 = bench.asof(start), bench.asof(end)
        out[h] = b1 / b0 - 1 if pd.notna(b0) and pd.notna(b1) and b0 else np.nan
    return out


def summarize(events: pd.DataFrame, horizons=HORIZONS) -> pd.DataFrame:
    """Per direction and horizon: count, mean/median return and excess, hit rate."""
    rows = []
    for direction, grp in events.groupby("direction"):
        for h in horizons:
            ret, exc = grp[f"ret_{h}"].dropna(), grp[f"exc_{h}"].dropna()
            rows.append({
                "direction": direction,
                "horizon_days": h,
                "events": int(ret.size),
                "mean_return": ret.mean() if ret.size else np.nan,
                "median_return": ret.median() if ret.size else np.nan,
                "mean_excess": exc.mean() if exc.size else np.nan,
                "hit_rate": (exc > 0).mean() if exc.size else np.nan,
            })
    return pd.DataFrame(rows)


def clusters(events: pd.DataFrame, min_people: int = 2, window_days: int = 30,
             direction: str = "buy") -> pd.DataFrame:
    """Stocks where >= min_people distinct promoters traded the same way within window_days."""
    df = events[events["direction"] == direction]
    out = []
    for sym, grp in df.groupby("symbol"):
        grp = grp.sort_values("event_date")
        dates = grp["event_date"].to_numpy()
        people = grp["person"].to_numpy()
        values = grp["value"].fillna(0).to_numpy()
        best = None
        for i in range(len(grp)):
            mask = (dates >= dates[i]) & (dates <= dates[i] + np.timedelta64(window_days, "D"))
            n = len(set(people[mask]))
            if n >= min_people and (best is None or n > best[1]):
                best = (i, n, values[mask].sum(), dates[mask].max())
        if best:
            i, n, total, last = best
            out.append({"symbol": sym, "company": grp["company"].iloc[0],
                        "start": pd.Timestamp(dates[i]), "end": pd.Timestamp(last),
                        "promoters": n, "total_value": total})
    return pd.DataFrame(out, columns=["symbol", "company", "start", "end", "promoters",
                                      "total_value"]).sort_values("end", ascending=False,
                                                                  ignore_index=True)


def leaderboard(events: pd.DataFrame) -> pd.DataFrame:
    """Net promoter value (buys minus sells) per stock."""
    if events.empty:
        return pd.DataFrame(columns=["symbol", "company", "net_value", "buys", "sells"])
    g = events.groupby("symbol")
    return pd.DataFrame({
        "company": g["company"].first(),
        "net_value": g["signed_value"].sum(),
        "buys": g["direction"].apply(lambda s: int((s == "buy").sum())),
        "sells": g["direction"].apply(lambda s: int((s == "sell").sum())),
    }).reset_index().sort_values("net_value", ascending=False, ignore_index=True)
