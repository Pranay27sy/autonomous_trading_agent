"""A 0–100 conviction score for each promoter buy, with the reasons behind it.

Not every promoter buy means the same thing. A token ₹10 lakh top-up is noise;
a promoter putting in many days' worth of trading volume, raising their stake
noticeably, alongside other promoters, after the price has fallen, is a much
stronger statement. Each factor scores 0–1 and is weighted:

    stake bought (% of company) .......... 25
    size vs normal daily trading value ... 20
    other promoters buying (30 days) ..... 20
    price below its 52-week high ......... 15
    same person buying again (90 days) ... 10
    rupee size ........................... 10

Sells, and buys flagged as internal transfers, get no score.
"""
from __future__ import annotations

import math
from typing import Callable

import numpy as np
import pandas as pd

WEIGHTS = {"stake": 25, "liquidity": 20, "cluster": 20, "dip": 15, "repeat": 10, "size": 10}
ADV_DAYS = 60           # trading days for the average daily traded value
HIGH_DAYS = 252         # trading days in the 52-week high
CLUSTER_DAYS = 30
REPEAT_DAYS = 90


def _clip(x: float) -> float:
    return float(min(max(x, 0.0), 1.0))


def _log_scale(x: float | None, at_zero: float, at_one: float) -> float:
    """0 at `at_zero`, 1 at `at_one`, logarithmic in between."""
    if x is None or not np.isfinite(x) or x <= 0:
        return 0.0
    return _clip(math.log10(x / at_zero) / math.log10(at_one / at_zero))


def _inr(v: float) -> str:
    return f"₹{v / 1e7:,.1f} cr" if v >= 1e7 else f"₹{v / 1e5:,.0f} L"


def score_buy(stake_pct: float | None, value: float | None, adv: float | None,
              n_promoters: int, prior_buys: int, drawdown: float | None) -> tuple[int, list[str], dict]:
    """(score 0–100, reasons strongest first, factor scores 0–1)."""
    f = {
        "stake": _log_scale(stake_pct, 0.005, 1.0),            # 0.005pp → 0, 1pp of company → 1
        "liquidity": _log_scale((value or 0) / adv if adv else None, 0.05, 3.0),
        "cluster": _clip((n_promoters - 1) / 3),                # 4+ promoters → 1
        "dip": _clip((drawdown or 0) / 0.35),                   # 35%+ below the high → 1
        "repeat": _clip(prior_buys / 3),
        "size": _log_scale(value, 5e5, 5e8),                    # ₹5 L → 0, ₹50 cr → 1
    }
    score = round(sum(WEIGHTS[k] * v for k, v in f.items()))
    reasons = []
    for k in sorted(f, key=lambda k: -WEIGHTS[k] * f[k]):
        if f[k] < 0.25:
            continue
        if k == "stake":
            reasons.append(f"raised their stake by {stake_pct:.2f}% of the company")
        elif k == "liquidity":
            reasons.append(f"{value / adv:.1f}× a normal day's trading value")
        elif k == "cluster":
            reasons.append(f"{n_promoters} promoters buying within {CLUSTER_DAYS} days")
        elif k == "dip":
            reasons.append(f"price {drawdown:.0%} below its 52-week high")
        elif k == "repeat":
            reasons.append(f"{prior_buys + 1}{_ordinal(prior_buys + 1)} buy by this person in "
                           f"{REPEAT_DAYS} days")
        elif k == "size":
            reasons.append(f"{_inr(value)} bought")
    return score, reasons, f


def _ordinal(n: int) -> str:
    return "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def add_conviction(events: pd.DataFrame, bars: Callable[[str], pd.DataFrame]) -> pd.DataFrame:
    """Add conviction (Int64, buys only) and conviction_reasons (list) columns.

    bars(symbol) -> daily bars with close and volume (Store.load_bars on .NS).
    """
    events = events.copy()
    scores = pd.Series(pd.NA, index=events.index, dtype="Int64")
    reasons = pd.Series([[] for _ in range(len(events))], index=events.index, dtype=object)
    transfer = events["internal_transfer"] if "internal_transfer" in events else False
    buys = events[(events["direction"] == "buy") & ~transfer]
    for sym, group in buys.groupby("symbol"):
        b = bars(sym)
        close = b["close"] if len(b) else pd.Series(dtype=float)
        traded = (b["close"] * b["volume"]) if len(b) and "volume" in b else pd.Series(dtype=float)
        group = group.sort_values("event_date")
        dates = group["event_date"].to_numpy()
        people = group["person"].to_numpy()
        for pos, (idx, e) in enumerate(group.iterrows()):
            when = e["event_date"]
            i = close.index.searchsorted(when, side="right") if len(close) else 0
            adv = traded.iloc[max(0, i - ADV_DAYS):i].mean() if i else None
            high = close.iloc[max(0, i - HIGH_DAYS):i].max() if i else None
            last = close.iloc[i - 1] if i else None
            drawdown = (1 - last / high) if high and last else None
            window = (dates >= when - np.timedelta64(CLUSTER_DAYS, "D")) & (dates <= when)
            n_promoters = len(set(people[window]))
            prior = (people[:pos] == e["person"]) & \
                (dates[:pos] >= when - np.timedelta64(REPEAT_DAYS, "D"))
            stake = e.get("holding_change_pct")
            if (stake is None or pd.isna(stake)) and e.get("market_cap"):
                stake = (e.get("value") or 0) / e["market_cap"] * 100
            s, r, _ = score_buy(None if pd.isna(stake) else float(stake), e.get("value"),
                                None if adv is None or pd.isna(adv) else float(adv),
                                n_promoters, int(prior.sum()), drawdown)
            scores[idx] = s
            reasons[idx] = r
    events["conviction"] = scores
    events["conviction_reasons"] = reasons
    return events
