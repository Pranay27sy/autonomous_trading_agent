"""Turn newly stored promoter trades into alerts.

After each refresh, scan() looks at trades first stored since the previous scan
and raises an alert for:
  - any promoter buy/sell in a watchlisted stock,
  - large promoter buys or sells in any stock (thresholds in AlertSettings),
  - a buying cluster: several promoters buying the same stock within a window.
Each alert is stored once (per trade, or per cluster), so overlapping refresh
windows don't repeat them. The very first scan only sets a baseline, so turning
alerts on doesn't flood you with your whole history.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import asdict, dataclass, fields

import pandas as pd

from . import analysis, conviction, pledges
from .prices import nse_ticker
from .store import Store

log = logging.getLogger(__name__)

SCAN_MARK = "alerts_scanned_through"  # meta key: first_seen high-water mark
SETTINGS_KEY = "alert_settings"


@dataclass
class AlertSettings:
    watchlist_trades: bool = True          # any promoter trade in a watched stock
    big_buy_value: float | None = 5e7      # ₹5 cr; None turns the rule off
    big_sell_value: float | None = 2.5e8   # ₹25 cr
    cluster_min_people: int | None = 3     # distinct promoters; None turns it off
    cluster_window_days: int = 30
    market_only: bool = True               # ignore gifts, pledges, ESOPs, ...
    min_conviction: int | None = None      # high-conviction buy in any stock; None = off
    pledge_invocations: bool = True        # lender invoked pledged promoter shares (any stock);
                                           # watched stocks also alert on new pledges

    @classmethod
    def load(cls, store: Store) -> AlertSettings:
        raw = json.loads(store.get_meta(SETTINGS_KEY) or "{}")
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in raw.items() if k in known})

    def save(self, store: Store) -> None:
        store.set_meta(SETTINGS_KEY, json.dumps(asdict(self)))


def inr(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "–"
    v = abs(value)
    s = f"₹{v / 1e7:,.1f} cr" if v >= 1e7 else f"₹{v / 1e5:,.1f} L"
    return ("−" if value < 0 else "") + s


def _day(ts) -> str:
    return pd.Timestamp(ts).strftime("%d %b %Y") if pd.notna(ts) else "–"


def _trade_alert(kind: str, group: pd.DataFrame) -> dict:
    """One alert for the new trades of one kind in one stock and direction."""
    e = group.sort_values("event_date").iloc[-1]
    side = "buy" if e["direction"] == "buy" else "sell"
    n = len(group)
    total = group["value"].fillna(0).sum()
    noun = {"watchlist": f"promoter {side.upper()}", "conviction": "high-conviction buy",
            "big_buy": "large promoter buy", "big_sell": "large promoter sell"}[kind]
    if n == 1:
        hold = ""
        if pd.notna(e.get("holding_before_pct")) and pd.notna(e.get("holding_after_pct")):
            hold = f" · holding {e['holding_before_pct']:.2f}% → {e['holding_after_pct']:.2f}%"
        title = f"{e['symbol']}: {noun} {inr(e.get('value'))}"
        if kind == "conviction":
            title += f" (score {int(e['conviction'])})"
        why = e.get("conviction_reasons")
        why = f" · {'; '.join(why[:3])}" if kind == "conviction" and isinstance(why, list) and why else ""
        detail = (f"{e.get('person') or 'Promoter'} · {e.get('mode') or ''}{hold}{why} · "
                  f"disclosed {_day(e.get('disclosure_date'))}")
        key = e["trade_key"]
    else:
        people = list(dict.fromkeys(group["person"].fillna("Promoter")))
        names = ", ".join(people[:3]) + (f" and {len(people) - 3} more" if len(people) > 3 else "")
        title = f"{e['symbol']}: {n} {noun}s {inr(total)}"
        detail = f"{names} · disclosed {_day(group['disclosure_date'].min())}" + (
            f" – {_day(group['disclosure_date'].max())}"
            if group["disclosure_date"].nunique() > 1 else "")
        key = hashlib.sha1("|".join(sorted(group["trade_key"])).encode(),
                           usedforsecurity=False).hexdigest()
    return {
        "kind": kind,
        "dedup_key": key,
        "symbol": e["symbol"],
        "company": e.get("company"),
        "direction": side,
        "value": float(total),
        "event_date": pd.Timestamp(e["event_date"]).date().isoformat(),
        "title": title,
        "detail": detail,
    }


def evaluate(new_events: pd.DataFrame, all_events: pd.DataFrame, watchlist: set[str],
             s: AlertSettings) -> list[dict]:
    """Alerts for new_events (promoter events of the newly stored trades).

    all_events (every promoter event) is needed to see clusters that a new
    trade completes together with older ones.
    """
    def kind(e: pd.Series) -> str | None:
        value = e.get("value") or 0
        if s.watchlist_trades and e["symbol"] in watchlist:
            return "watchlist"
        if (e["direction"] == "buy" and s.min_conviction is not None
                and pd.notna(e.get("conviction")) and e["conviction"] >= s.min_conviction):
            return "conviction"
        if e["direction"] == "buy" and s.big_buy_value is not None and value >= s.big_buy_value:
            return "big_buy"
        if e["direction"] == "sell" and s.big_sell_value is not None and value >= s.big_sell_value:
            return "big_sell"
        return None

    out: list[dict] = []
    if not new_events.empty:
        tagged = new_events.assign(kind=[kind(e) for _, e in new_events.iterrows()])
        tagged = tagged[tagged["kind"].notna()]
        for (k, _sym, _dir), group in tagged.groupby(["kind", "symbol", "direction"], sort=False):
            out.append(_trade_alert(k, group))

    if s.cluster_min_people:
        new_buys = new_events[new_events["direction"] == "buy"]
        symbols = set(new_buys["symbol"])
        if symbols:
            pool = all_events[all_events["symbol"].isin(symbols)]
            cl = analysis.clusters(pool, s.cluster_min_people, s.cluster_window_days)
            first_new = new_buys.groupby("symbol")["event_date"].min()
            for _, c in cl.iterrows():
                if c["end"] < first_new[c["symbol"]]:
                    continue  # an old cluster; the new buy isn't part of it
                out.append({
                    "kind": "cluster",
                    "dedup_key": f"{c['symbol']}:{pd.Timestamp(c['start']).date().isoformat()}",
                    "symbol": c["symbol"],
                    "company": c["company"],
                    "direction": "buy",
                    "value": float(c["total_value"]),
                    "event_date": pd.Timestamp(c["end"]).date().isoformat(),
                    "title": f"{c['symbol']}: {c['promoters']} promoters bought within "
                             f"{s.cluster_window_days} days ({inr(c['total_value'])})",
                    "detail": f"{c['company']} · {_day(c['start'])} → {_day(c['end'])}",
                })
    # A cluster alert already covers that stock's large buys.
    clustered = {a["symbol"] for a in out if a["kind"] == "cluster"}
    return [a for a in out if not (a["kind"] == "big_buy" and a["symbol"] in clustered)]


def pledge_alerts(new_trades: pd.DataFrame, watchlist: set[str], s: AlertSettings,
                  closes) -> list[dict]:
    """Invocations in any stock (if enabled); any pledge event in a watched stock."""
    pe = pledges.pledge_events(new_trades, closes)
    pe = pe[(s.pledge_invocations & (pe["kind"] == "invoked")) | pe["symbol"].isin(watchlist)] \
        if not pe.empty else pe
    out = []
    for (sym, kind), g in pe.groupby(["symbol", "kind"], sort=False):
        verb = {"invoked": "lender invoked pledged promoter shares",
                "created": "promoter pledged shares", "released": "promoter pledge released"}[kind]
        people = ", ".join(dict.fromkeys(g["person"].fillna("Promoter")))
        out.append({
            "kind": "pledge",
            "dedup_key": hashlib.sha1("|".join(sorted(g["trade_key"])).encode(),
                                      usedforsecurity=False).hexdigest(),
            "symbol": sym, "company": g["company"].iloc[0],
            "direction": "sell" if kind != "released" else "buy",
            "value": float(g["value"].fillna(0).sum()) or None,
            "event_date": pd.Timestamp(g["event_date"].max()).date().isoformat(),
            "title": f"{sym}: {verb} ({g['quantity'].fillna(0).sum():,.0f} shares, "
                     f"~{inr(g['value'].fillna(0).sum())})",
            "detail": f"{people} · disclosed {_day(g['event_date'].max())}",
        })
    return out


def scan(store: Store) -> list[dict]:
    """Raise alerts for trades stored since the last scan. Returns the new alerts."""
    mark = store.get_meta(SCAN_MARK)
    latest = store.max_first_seen()
    if mark is None:
        # First run: start watching from now instead of alerting on all history.
        store.set_meta(SCAN_MARK, latest or "")
        return []
    new = store.load_trades(seen_after=mark)
    if new.empty:
        return []
    s = AlertSettings.load(store)
    # Events across all trades, so a new buy can pair with its transfer partner
    # (or join a cluster) even when the other side arrived earlier.
    all_events = analysis.promoter_events(store.load_trades(), market_only=s.market_only)
    all_events = all_events[~all_events["internal_transfer"]]
    if s.min_conviction is not None and not all_events.empty:
        all_events = conviction.add_conviction(all_events,
                                               lambda sym: store.load_bars(nse_ticker(sym)))
    new_events = all_events[all_events["trade_key"].isin(set(new["trade_key"]))]
    watch = {w["symbol"] for w in store.watchlist()}
    raised = evaluate(new_events, all_events, watch, s) if not new_events.empty else []
    raised += pledge_alerts(new, watch, s, lambda sym: store.load_prices(nse_ticker(sym)))
    added = store.add_alerts(raised)
    store.set_meta(SCAN_MARK, latest or mark)
    if added:
        log.info("Raised %d alerts", len(added))
    return added
