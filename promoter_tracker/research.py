"""Backtests and event studies over promoter trades.

Both use the same entry convention as the rest of the app: the close of the
first trading day after the event date (disclosures often land after hours).
Returns are measured on adjusted closes; excess = stock minus Nifty 50 over
the same dates. No transaction costs or slippage are modelled.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

Closes = Callable[[str], pd.Series]


@dataclass(frozen=True)
class Rule:
    """Which promoter trades a strategy acts on, and how long it holds."""
    side: str = "buy"                       # "buy", or "sell" (short the stock)
    hold_days: int = 60                     # trading days
    min_value: float = 1e6
    min_conviction: int | None = None       # buys only
    min_stake_pct: float | None = None      # holding change, percentage points
    sectors: tuple[str, ...] = ()           # empty = all
    caps: tuple[str, ...] = ()              # market-cap buckets; empty = all
    start: str | None = None                # event dates, YYYY-MM-DD
    end: str | None = None
    one_per_stock_days: int = 0             # skip repeat signals in a stock within N days


def select(events: pd.DataFrame, rule: Rule) -> pd.DataFrame:
    """The events a rule trades, oldest first."""
    if events.empty:
        return events
    e = events[(events["direction"] == rule.side) & ~events["internal_transfer"]
               & events["returns_valid"] & (events["value"].fillna(0) >= rule.min_value)]
    if rule.min_conviction is not None and "conviction" in e:
        e = e[e["conviction"].fillna(-1) >= rule.min_conviction]
    if rule.min_stake_pct is not None:
        e = e[e["holding_change_pct"].abs().fillna(0) >= rule.min_stake_pct]
    if rule.sectors:
        e = e[e["sector"].isin(rule.sectors)]
    if rule.caps:
        e = e[e["cap_bucket"].isin(rule.caps)]
    if rule.start:
        e = e[e["event_date"] >= pd.Timestamp(rule.start)]
    if rule.end:
        e = e[e["event_date"] <= pd.Timestamp(rule.end)]
    e = e.sort_values("event_date")
    if rule.one_per_stock_days:
        keep, last = [], {}
        gap = pd.Timedelta(days=rule.one_per_stock_days)
        for i, (sym, when) in enumerate(zip(e["symbol"], e["event_date"], strict=True)):
            if sym not in last or when - last[sym] >= gap:
                keep.append(i)
                last[sym] = when
        e = e.iloc[keep]
    return e


@dataclass
class _Prices:
    closes: Closes
    bench: pd.Series
    cache: dict = field(default_factory=dict)

    def get(self, sym: str) -> pd.Series:
        if sym not in self.cache:
            self.cache[sym] = self.closes(sym).dropna().sort_index()
        return self.cache[sym]


def _bootstrap_ci(x: np.ndarray, n: int = 2000, seed: int = 7) -> tuple[float, float]:
    if len(x) < 2:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = rng.choice(x, size=(n, len(x)), replace=True).mean(axis=1)
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def _max_drawdown(equity: pd.Series) -> float:
    if equity.empty:
        return float("nan")
    return float((equity / equity.cummax() - 1).min())


def backtest(events: pd.DataFrame, closes: Closes, bench: pd.Series, rule: Rule) -> dict:
    """Trade every selected event for rule.hold_days and summarise the results."""
    px = _Prices(closes, bench.dropna().sort_index())
    sign = 1 if rule.side == "buy" else -1
    trades, daily = [], []
    for _, e in select(events, rule).iterrows():
        p = px.get(e["symbol"])
        i = p.index.searchsorted(e["event_date"], side="right")
        if i + rule.hold_days >= len(p):
            continue  # not enough history after the event yet
        entry, exit_ = p.index[i], p.index[i + rule.hold_days]
        ret = p.iloc[i + rule.hold_days] / p.iloc[i] - 1
        b0, b1 = px.bench.asof(entry), px.bench.asof(exit_)
        bret = b1 / b0 - 1 if pd.notna(b0) and pd.notna(b1) and b0 else np.nan
        trades.append({
            "symbol": e["symbol"], "company": e.get("company"), "person": e.get("person"),
            "event_date": e["event_date"], "entry": entry, "exit": exit_,
            "value": e.get("value"), "conviction": e.get("conviction"),
            "return": sign * ret, "benchmark": sign * bret, "excess": sign * (ret - bret),
        })
        # Daily returns while held, for the portfolio curve.
        daily.append(sign * p.iloc[i:i + rule.hold_days + 1].pct_change().iloc[1:])

    t = pd.DataFrame(trades)
    if t.empty:
        return {"rule": rule.__dict__, "stats": {"trades": 0}, "equity": [], "trades": []}
    exc = t["excess"].dropna().to_numpy()
    lo, hi = _bootstrap_ci(exc)
    sd = exc.std(ddof=1) if len(exc) > 1 else float("nan")

    # Equal-weight portfolio of whatever positions are open each day; flat when none.
    stacked = pd.concat(daily, axis=1)
    port = stacked.mean(axis=1).sort_index()
    days = pd.DatetimeIndex(px.bench.index[(px.bench.index >= port.index[0])
                                           & (px.bench.index <= port.index[-1])])
    port = port.reindex(days.union(port.index)).fillna(0.0)
    invested = stacked.notna().any(axis=1).reindex(port.index, fill_value=False)
    equity = (1 + port).cumprod()
    bench_eq = (px.bench.reindex(port.index).ffill() / px.bench.asof(port.index[0]))
    years = max((port.index[-1] - port.index[0]).days / 365.25, 1e-9)

    stats = {
        "trades": len(t),
        "stocks": int(t["symbol"].nunique()),
        "hit_rate": float((t["excess"] > 0).mean()),
        "mean_return": float(t["return"].mean()),
        "median_return": float(t["return"].median()),
        "mean_excess": float(np.mean(exc)) if len(exc) else None,
        "median_excess": float(np.median(exc)) if len(exc) else None,
        "excess_ci95": [lo, hi],
        "t_stat": float(np.mean(exc) / (sd / np.sqrt(len(exc)))) if len(exc) > 1 and sd else None,
        "best": float(t["excess"].max()),
        "worst": float(t["excess"].min()),
        "strategy_total": float(equity.iloc[-1] - 1),
        "benchmark_total": float(bench_eq.iloc[-1] - 1),
        "strategy_cagr": float(equity.iloc[-1] ** (1 / years) - 1),
        "benchmark_cagr": float(bench_eq.iloc[-1] ** (1 / years) - 1),
        "max_drawdown": _max_drawdown(equity),
        "benchmark_max_drawdown": _max_drawdown(bench_eq),
        "time_invested": float(invested.mean()),
        "from": port.index[0].date().isoformat(),
        "to": port.index[-1].date().isoformat(),
    }
    curve = [{"time": d.date().isoformat(), "strategy": round(float(s), 5),
              "benchmark": round(float(b), 5)}
             for d, s, b in zip(equity.index, equity, bench_eq, strict=True) if pd.notna(b)]
    return {"rule": rule.__dict__, "stats": stats, "equity": curve,
            "trades": t.sort_values("event_date", ascending=False).to_dict("records")}


def event_study(events: pd.DataFrame, closes: Closes, bench: pd.Series,
                before: int = 20, after: int = 120, groups: str = "side") -> dict:
    """Average cumulative excess return around promoter trades, with a 95% band.

    Day 0 is the entry (first trading day after the event). Each path is
    rebased to 0 at day 0, so days before show what happened ahead of the
    trade. groups: "side" (buys vs sells) or "conviction" (buy tiers).
    """
    px = _Prices(closes, bench.dropna().sort_index())
    e = events[~events["internal_transfer"] & events["returns_valid"]]
    if groups == "conviction":
        e = e[(e["direction"] == "buy") & e["conviction"].notna()]
        label = pd.cut(e["conviction"].astype(float), [-1, 35, 60, 101],
                       labels=["Low (0–34)", "Medium (35–59)", "High (60+)"]).astype(str)
    else:
        label = e["direction"].map({"buy": "Promoter buys", "sell": "Promoter sells"})
    offsets = np.arange(-before, after + 1)
    out = []
    for name in label.dropna().unique():
        paths = []
        for _, ev in e[label == name].iterrows():
            p = px.get(ev["symbol"])
            i = p.index.searchsorted(ev["event_date"], side="right")
            if i - before < 0 or i >= len(p):
                continue
            j = np.arange(i - before, min(i + after, len(p) - 1) + 1)
            stock = p.iloc[j].to_numpy() / p.iloc[i] - 1
            b = px.bench.reindex(p.index[j], method="ffill").to_numpy()
            b0 = px.bench.asof(p.index[i])
            if not b0 or np.isnan(b0):
                continue
            path = np.full(len(offsets), np.nan)
            path[: len(j)] = stock - (b / b0 - 1)
            paths.append(path)
        if not paths:
            continue
        m = np.vstack(paths)
        n = np.sum(~np.isnan(m), axis=0)
        mean = np.nanmean(m, axis=0)
        sd = np.nanstd(m, axis=0, ddof=1)
        half = 1.96 * sd / np.sqrt(np.maximum(n, 1))
        out.append({"group": name, "events": len(paths), "points": [
            {"day": int(d), "mean": _num(mu), "lo": _num(mu - h), "hi": _num(mu + h), "n": int(k)}
            for d, mu, h, k in zip(offsets, mean, half, n, strict=True) if k >= 5]})
    order = ["Promoter buys", "Promoter sells", "High (60+)", "Medium (35–59)", "Low (0–34)"]
    out.sort(key=lambda g: order.index(g["group"]) if g["group"] in order else 99)
    return {"before": before, "after": after, "groups": out}


def _num(x: float) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 5)
