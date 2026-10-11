"""Classical chart patterns, detected by fixed rules on daily closes.

Patterns are built from swing points (pivots): a close that is the highest
(or lowest) within PIVOT_ORDER trading days on each side. A pivot at bar i is
only *known* at bar i + PIVOT_ORDER, so a pattern counts only when it breaks
out after its last pivot was confirmed: nothing here peeks into the future,
which matters because the breakout day is what the backtests trade.

Detected (bullish ↑ / bearish ↓):
    head and shoulders ↓, inverse head and shoulders ↑,
    double top ↓, double bottom ↑, cup and handle ↑,
    ascending triangle ↑, descending triangle ↓.

The thresholds follow common textbook definitions; they're constants so the
rules are explicit and testable, not tuned to make results look good.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

PIVOT_ORDER = 5            # bars on each side for a swing high/low
MIN_SWING = 0.05           # a swing must move at least 5% from the previous one (zigzag)
MAX_BREAKOUT_WAIT = 30     # bars after the last confirmed pivot to break out
SHOULDER_TOLERANCE = 0.06  # shoulders within 6% of each other
HEAD_MARGIN = 0.03         # head at least 3% beyond both shoulders
TWIN_TOLERANCE = 0.03      # double top/bottom peaks within 3%
TWIN_MIN_DEPTH = 0.06      # and the middle at least 6% away
TWIN_MIN_GAP = 10          # bars between the two peaks
CUP_DEPTH = (0.12, 0.45)   # cup bottom 12–45% below the left rim
CUP_BARS = (30, 260)       # left rim to right rim
RIM_TOLERANCE = 0.05       # right rim within 5% of the left
HANDLE_DEPTH = (0.02, 0.15)
HANDLE_MAX_BARS = 40
FLAT_TOLERANCE = 0.025     # triangle's flat side
TRIANGLE_MIN_BARS = 20

PATTERNS = {
    "head_shoulders": ("Head and shoulders", "bear"),
    "inverse_head_shoulders": ("Inverse head and shoulders", "bull"),
    "double_top": ("Double top", "bear"),
    "double_bottom": ("Double bottom", "bull"),
    "cup_handle": ("Cup and handle", "bull"),
    "ascending_triangle": ("Ascending triangle", "bull"),
    "descending_triangle": ("Descending triangle", "bear"),
}


@dataclass
class Detection:
    symbol: str
    pattern: str
    direction: str                  # "bull" or "bear"
    start: pd.Timestamp             # first pivot
    breakout: pd.Timestamp          # first close through the level
    breakout_price: float
    level: float                    # neckline / rim / flat side at the breakout
    target: float                   # level ± pattern height (textbook measured move)
    points: list[dict] = field(default_factory=list)  # pivots: {time, price, label}
    line: list[dict] = field(default_factory=list)    # neckline/rim: two {time, price}
    volume_ratio: float | None = None  # breakout volume / 50-day average

    @property
    def name(self) -> str:
        return PATTERNS[self.pattern][0]


@dataclass(frozen=True)
class Pivot:
    i: int
    kind: str      # "H" or "L"
    price: float


def pivots(close: np.ndarray, order: int = PIVOT_ORDER, min_swing: float = MIN_SWING) -> list[Pivot]:
    """Alternating swing highs and lows, each at least min_swing from the last.

    Runs of the same kind keep the extreme; an opposite swing smaller than
    min_swing is noise and is skipped (the zigzag rule).
    """
    n = len(close)
    raw: list[Pivot] = []
    for i in range(order, n - order):
        window = close[i - order:i + order + 1]
        if close[i] == window.max() and close[i] > close[i - 1]:
            raw.append(Pivot(i, "H", float(close[i])))
        elif close[i] == window.min() and close[i] < close[i - 1]:
            raw.append(Pivot(i, "L", float(close[i])))
    out: list[Pivot] = []
    for p in raw:
        if not out:
            out.append(p)
        elif out[-1].kind == p.kind:
            better = p.price > out[-1].price if p.kind == "H" else p.price < out[-1].price
            if better:
                out[-1] = p
        elif abs(p.price / out[-1].price - 1) >= min_swing:
            out.append(p)
    return out


def _line_at(a: Pivot, b: Pivot, i: int) -> float:
    """Value at bar i of the straight line through two pivots."""
    if a.i == b.i:
        return a.price
    return a.price + (b.price - a.price) * (i - a.i) / (b.i - a.i)


def _breakout(close: np.ndarray, start: int, level, up: bool) -> int | None:
    """First bar >= start (within the wait) that closes through level(i)."""
    for i in range(start, min(start + MAX_BREAKOUT_WAIT, len(close))):
        lv = level(i)
        if (close[i] > lv) if up else (close[i] < lv):
            return i
    return None


def _close(a: float, b: float, tol: float) -> bool:
    return abs(a - b) / ((a + b) / 2) <= tol


def detect(symbol: str, bars: pd.DataFrame) -> list[Detection]:
    """All patterns in a stock's daily bars (close, optional volume), oldest first."""
    if bars is None or len(bars) < 60:
        return []
    bars = bars.dropna(subset=["close"]).sort_index()
    close = bars["close"].to_numpy(dtype=float)
    dates = bars.index
    vol = bars["volume"].to_numpy(dtype=float) if "volume" in bars else None
    pv = pivots(close)
    found: dict[tuple, Detection] = {}

    def add(pattern: str, pts: list[Pivot], labels: list[str], level, up: bool,
            height: float, line_pts: tuple[Pivot, Pivot]) -> None:
        last = pts[-1]
        b = _breakout(close, last.i + PIVOT_ORDER, level, up)
        if b is None:
            return
        key = (pattern, b)
        if key in found:
            return
        lv = float(level(b))
        ratio = None
        if vol is not None and b >= 20:
            avg = np.nanmean(vol[max(0, b - 50):b])
            ratio = float(vol[b] / avg) if avg and np.isfinite(avg) and np.isfinite(vol[b]) else None
        a, z = line_pts
        found[key] = Detection(
            symbol=symbol, pattern=pattern, direction=PATTERNS[pattern][1],
            start=dates[pts[0].i], breakout=dates[b], breakout_price=float(close[b]), level=lv,
            target=lv + height if up else lv - height,
            points=[{"time": dates[p.i], "price": p.price, "label": lab}
                    for p, lab in zip(pts, labels, strict=True)],
            line=[{"time": dates[a.i], "price": a.price},
                  {"time": dates[b], "price": lv}],
            volume_ratio=ratio,
        )

    for k in range(len(pv)):
        # Head and shoulders: H L H L H (and the mirror for inverse).
        if k + 5 <= len(pv):
            s1, t1, hd, t2, s2 = pv[k:k + 5]
            if s1.kind == "H":
                if (hd.price > max(s1.price, s2.price) * (1 + HEAD_MARGIN)
                        and _close(s1.price, s2.price, SHOULDER_TOLERANCE)):
                    add("head_shoulders", [s1, t1, hd, t2, s2],
                        ["Left shoulder", "", "Head", "", "Right shoulder"],
                        lambda i, t1=t1, t2=t2: _line_at(t1, t2, i),  # the neckline
                        False, hd.price - _line_at(t1, t2, hd.i), (t1, t2))
            else:
                if (hd.price < min(s1.price, s2.price) * (1 - HEAD_MARGIN)
                        and _close(s1.price, s2.price, SHOULDER_TOLERANCE)):
                    add("inverse_head_shoulders", [s1, t1, hd, t2, s2],
                        ["Left shoulder", "", "Head", "", "Right shoulder"],
                        lambda i, t1=t1, t2=t2: _line_at(t1, t2, i),  # the neckline
                        True, _line_at(t1, t2, hd.i) - hd.price, (t1, t2))
        # Double top / bottom: H L H (L H L).
        if k + 3 <= len(pv):
            p1, mid, p2 = pv[k:k + 3]
            if p2.i - p1.i >= TWIN_MIN_GAP and _close(p1.price, p2.price, TWIN_TOLERANCE):
                peak = (p1.price + p2.price) / 2
                if p1.kind == "H" and mid.price <= peak * (1 - TWIN_MIN_DEPTH):
                    add("double_top", [p1, mid, p2], ["Top", "", "Top"],
                        lambda i, m=mid: m.price, False, peak - mid.price, (mid, mid))
                elif p1.kind == "L" and mid.price >= peak * (1 + TWIN_MIN_DEPTH):
                    add("double_bottom", [p1, mid, p2], ["Bottom", "", "Bottom"],
                        lambda i, m=mid: m.price, True, mid.price - peak, (mid, mid))
        # Cup and handle: H (rim) L (cup) H (rim) L (handle).
        if k + 4 <= len(pv) and pv[k].kind == "H":
            left, bottom, right, handle = pv[k:k + 4]
            depth = 1 - bottom.price / left.price
            bars_ = right.i - left.i
            handle_depth = 1 - handle.price / right.price
            if (CUP_DEPTH[0] <= depth <= CUP_DEPTH[1] and CUP_BARS[0] <= bars_ <= CUP_BARS[1]
                    and right.price >= left.price * (1 - RIM_TOLERANCE)
                    and right.price <= left.price * (1 + RIM_TOLERANCE)
                    and HANDLE_DEPTH[0] <= handle_depth <= HANDLE_DEPTH[1]
                    and handle.i - right.i <= HANDLE_MAX_BARS
                    and handle.price > (left.price + bottom.price) / 2):
                rim = max(left.price, right.price)
                add("cup_handle", [left, bottom, right, handle],
                    ["Left rim", "Cup", "Right rim", "Handle"],
                    lambda i, r=rim: r, True, rim - bottom.price, (right, right))
        # Triangles: two highs and two lows, alternating, over enough bars.
        if k + 4 <= len(pv):
            four = pv[k:k + 4]
            highs = [p for p in four if p.kind == "H"]
            lows = [p for p in four if p.kind == "L"]
            if len(highs) == 2 and len(lows) == 2 and four[-1].i - four[0].i >= TRIANGLE_MIN_BARS:
                (h1, h2), (l1, l2) = highs, lows
                if _close(h1.price, h2.price, FLAT_TOLERANCE) and l2.price > l1.price * 1.02:
                    top = max(h1.price, h2.price)
                    add("ascending_triangle", four, [""] * 4, lambda i, t=top: t, True,
                        top - l1.price, (h1, h2))
                elif _close(l1.price, l2.price, FLAT_TOLERANCE) and h2.price < h1.price * 0.98:
                    floor = min(l1.price, l2.price)
                    add("descending_triangle", four, [""] * 4, lambda i, f=floor: f, False,
                        h1.price - floor, (l1, l2))
    # Overlapping swing windows can find the same formation twice; keep the
    # first of each pattern type and drop any that starts before it broke out.
    kept: list[Detection] = []
    last_breakout: dict[str, pd.Timestamp] = {}
    for d in sorted(found.values(), key=lambda d: d.breakout):
        if d.pattern in last_breakout and d.start < last_breakout[d.pattern]:
            continue
        kept.append(d)
        last_breakout[d.pattern] = d.breakout
    return kept


def to_frame(detections: list[Detection]) -> pd.DataFrame:
    cols = ["symbol", "pattern", "name", "direction", "start", "breakout", "breakout_price",
            "level", "target", "volume_ratio", "points", "line"]
    return pd.DataFrame([{**{c: getattr(d, c) for c in cols if c != "name"}, "name": d.name}
                         for d in detections], columns=cols)


def scan(symbols: list[str], bars, since: pd.Timestamp | None = None) -> pd.DataFrame:
    """Detections for many stocks; bars(symbol) -> daily bars DataFrame.

    since: only look at bars from this date (older history adds work, not insight).
    """
    out = []
    for s in symbols:
        b = bars(s)
        if since is not None and len(b):
            b = b[b.index >= since]
        try:
            out.extend(detect(s, b))
        except Exception:  # noqa: S112 - one odd price history must not stop the scan
            continue
    return to_frame(out)


def with_promoter_context(det: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """Add promoter buying/selling in each pattern's window (start → breakout).

    Per stock, cumulative sums over date-sorted trades turn each window into two
    binary searches, instead of filtering the trades once per pattern.
    """
    det = det.copy()
    if det.empty or events.empty:
        return det.assign(promoter_buys=0, promoter_net_value=0.0, promoter_buying=False)
    e = events[~events["internal_transfer"]] if "internal_transfer" in events else events
    buys = np.zeros(len(det), dtype=int)
    net = np.zeros(len(det))
    pos = {sym: np.flatnonzero(det["symbol"].to_numpy() == sym) for sym in det["symbol"].unique()}
    for sym, g in e.groupby("symbol"):
        rows = pos.get(sym)
        if rows is None:
            continue
        g = g.sort_values("event_date")
        dates = g["event_date"].to_numpy()
        cum_buys = np.r_[0, np.cumsum((g["direction"] == "buy").to_numpy())]
        cum_net = np.r_[0, np.cumsum(g["signed_value"].to_numpy(dtype=float))]
        lo = np.searchsorted(dates, det["start"].to_numpy()[rows], side="left")
        hi = np.searchsorted(dates, det["breakout"].to_numpy()[rows], side="right")
        buys[rows] = cum_buys[hi] - cum_buys[lo]
        net[rows] = cum_net[hi] - cum_net[lo]
    det["promoter_buys"] = buys
    det["promoter_net_value"] = net
    det["promoter_buying"] = det["promoter_net_value"] > 0
    return det

HORIZONS = (5, 20, 60)


def with_returns(det: pd.DataFrame, closes, bench: pd.Series) -> pd.DataFrame:
    """Add exc_{h} (return minus Nifty after the breakout) and signed_{h} per pattern.

    signed_{h} is excess in the pattern's direction, so positive means it worked
    (up for bullish, down for bearish). Entry is the close of the first trading
    day after the breakout, as everywhere else in the app.
    """
    if det.empty:
        return det
    det = det.copy()
    b = bench.dropna().sort_index()
    out = {h: np.full(len(det), np.nan) for h in HORIZONS}
    for sym, rows in det.groupby("symbol").indices.items():
        px = closes(sym).dropna().sort_index()
        if not len(px):
            continue
        values = px.to_numpy(dtype=float)
        entry = px.index.searchsorted(det["breakout"].to_numpy()[rows], side="right")
        for h in HORIZONS:
            ok = entry + h < len(px)
            if not ok.any():
                continue
            i0, i1 = entry[ok], entry[ok] + h
            stock = values[i1] / values[i0] - 1
            b0 = b.reindex(px.index[i0], method="ffill").to_numpy()
            b1 = b.reindex(px.index[i1], method="ffill").to_numpy()
            out[h][rows[ok]] = stock - (b1 / b0 - 1)
    sign = np.where(det["direction"] == "bull", 1, -1)
    for h in HORIZONS:
        det[f"exc_{h}"] = out[h]
        det[f"signed_{h}"] = out[h] * sign
    return det

def stats(det: pd.DataFrame) -> list[dict]:
    """How each pattern did after its breakout, overall and with/without promoter buying."""
    out = []
    for key, (name, direction) in PATTERNS.items():
        g = det[det["pattern"] == key] if not det.empty else det
        row = {"pattern": key, "name": name, "direction": direction, "count": len(g)}
        for label, part in (("all", g),
                            ("promoter", g[g["promoter_buying"]] if len(g) else g),
                            ("no_promoter", g[~g["promoter_buying"]] if len(g) else g)):
            s60 = part["signed_60"].dropna() if len(part) else pd.Series(dtype=float)
            s20 = part["signed_20"].dropna() if len(part) else pd.Series(dtype=float)
            row[label] = {
                "n": int(len(s60)),
                "mean_20": float(s20.mean()) if len(s20) else None,
                "mean_60": float(s60.mean()) if len(s60) else None,
                "median_60": float(s60.median()) if len(s60) else None,
                "worked_60": float((s60 > 0).mean()) if len(s60) else None,
            }
        out.append(row)
    return out
