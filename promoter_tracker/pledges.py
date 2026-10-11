"""Promoter share pledges: creations, releases and invocations.

Promoters pledge shares as collateral for loans. Rising pledges can signal
financial stress, and an invocation (the lender seizing pledged shares) often
means forced selling. NSE's insider disclosures carry these events, but they
aren't buys or sells, so the rest of the app leaves them out.

The value field on pledge filings is unreliable (filers type things like 47),
so each event is valued at quantity x that day's closing price instead.
"""
from __future__ import annotations

from typing import Callable

import pandas as pd

from .analysis import is_promoter

KINDS = ("created", "released", "invoked")
RECENT_DAYS = 90  # an invocation this recent marks a company high risk


def classify(txn_type: str | None, mode: str | None) -> str | None:
    t = (txn_type or "").strip().lower()
    m = (mode or "").strip().lower()
    if "invoke" in t or "invocation" in m:
        return "invoked"
    if "revoke" in t or any(w in m for w in ("release", "revocation", "revokation")):
        return "released"
    if t == "pledge" or "pledge creation" in m:
        return "created"
    return None


def pledge_events(trades: pd.DataFrame, closes: Callable[[str], pd.Series]) -> pd.DataFrame:
    """Promoter pledge events, newest first, valued at that day's close."""
    cols = ["symbol", "company", "person", "kind", "quantity", "value", "event_date",
            "holding_before_pct", "holding_after_pct", "trade_key"]
    if trades.empty:
        return pd.DataFrame(columns=cols)
    p = trades[trades["category"].map(is_promoter)].copy()
    p["kind"] = [classify(t, m) for t, m in zip(p["txn_type"], p["mode"], strict=True)]
    p = p[p["kind"].notna()]
    p["event_date"] = p["disclosure_date"].fillna(p["trade_to"])
    p = p[p["event_date"].notna()]
    values, seen = [], {}
    for sym, when, qty in zip(p["symbol"], p["event_date"], p["quantity"], strict=True):
        if sym not in seen:
            seen[sym] = closes(sym)  # one price load per stock, not per filing
        px = seen[sym]
        close = px.asof(when) if len(px) else None
        values.append(float(qty) * float(close) if qty and close is not None and pd.notna(close)
                      else None)
    p["value"] = values
    return p[cols].sort_values("event_date", ascending=False).reset_index(drop=True)


def summarize(events: pd.DataFrame, shares: pd.Series | None = None,
              asof: pd.Timestamp | None = None) -> list[dict]:
    """Per company: shares pledged, released and invoked, and a risk label.

    shares: shares outstanding by symbol, to express net pledging as % of the company.
    """
    if events.empty:
        return []
    asof = asof or events["event_date"].max()
    out = []
    for sym, g in events.groupby("symbol"):
        qty = {k: float(g.loc[g["kind"] == k, "quantity"].fillna(0).sum()) for k in KINDS}
        # None when no filing of that kind could be valued (no price for the stock).
        val = {k: (float(v.sum()) if v.notna().any() else None)
               for k in KINDS for v in [g.loc[g["kind"] == k, "value"]]}
        net = qty["created"] - qty["released"] - qty["invoked"]
        last_invoked = g.loc[g["kind"] == "invoked", "event_date"].max()
        recent_invocation = pd.notna(last_invoked) and asof - last_invoked <= pd.Timedelta(days=RECENT_DAYS)
        risk = "high" if recent_invocation else "rising" if net > 0 else "easing" if net < 0 else "flat"
        so = shares.get(sym) if shares is not None else None
        out.append({
            "symbol": sym,
            "company": g["company"].iloc[0],
            "events": len(g),
            "promoters": int(g["person"].nunique()),
            **{f"{k}_shares": qty[k] for k in KINDS},
            **{f"{k}_value": val[k] for k in KINDS},
            "net_shares": net,
            "net_pct": net / so * 100 if so and pd.notna(so) else None,
            "invocations": int((g["kind"] == "invoked").sum()),
            "last_event": g["event_date"].max(),
            "last_kind": g.sort_values("event_date")["kind"].iloc[-1],
            "risk": risk,
        })
    order = {"high": 0, "rising": 1, "flat": 2, "easing": 3}
    return sorted(out, key=lambda r: (order[r["risk"]], -abs(r["net_shares"] or 0)))
