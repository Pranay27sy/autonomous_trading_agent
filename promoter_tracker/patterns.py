"""Classical chart patterns, detected by explicit rules on daily bars (v2).

How it works
------------
1. Swing points. A swing high is a day whose *high* is the highest within
   PIVOT_ORDER trading days either side (swing lows use the *low*). A swing
   only counts if price moved far enough from the previous one, and "far
   enough" scales with the stock's own volatility: SWING_ATR x its average
   true range (ATR), clipped to 3-15%. A sleepy large-cap and a volatile
   micro-cap are judged on their own terms.
2. Templates. Consecutive swings are matched against each pattern's shape,
   with proportion and duration rules (below).
3. Context. Reversal patterns need a trend to reverse: a head and shoulders
   or double top needs a meaningful rise into it, their mirrors a fall, and a
   cup and handle an advance before the cup.
4. Confirmation. The breakout is the first close beyond the neckline / rim /
   flat side by at least BREAKOUT_ATR x ATR, after the last swing could have
   been known. Nothing looks into the future, so backtests stay honest.
5. Quality. Each pattern gets a 0-100 score (trend, shape, prominence,
   breakout strength, volume, duration) with the reasons spelled out.
6. One label per formation. Overlapping detections keep the best-scoring one.
7. Lifecycle. After the breakout: target hit, failed (price went back past
   the pattern's invalidation level), or still active. Patterns whose shape is
   complete but haven't broken out yet are reported as "forming".

Detected (bullish ↑ / bearish ↓): head and shoulders ↓, inverse head and
shoulders ↑, double top ↓, double bottom ↑, cup and handle ↑, ascending
triangle ↑, descending triangle ↓.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

# --- rules --------------------------------------------------------------------------
PIVOT_ORDER = 5            # bars either side for a swing high/low
ATR_DAYS = 14
SWING_ATR = 2.5            # minimum swing = 2.5 x ATR ...
SWING_RANGE = (0.03, 0.15)  # ... but never below 3% or above 15%
BREAKOUT_ATR = 0.5         # close must clear the level by half a day's typical range
MAX_BREAKOUT_WAIT = 30     # bars after the last swing is confirmed
TREND_LOOKBACK = 120       # bars before a pattern to measure the move into it
MIN_REVERSAL_TREND = 0.15  # 15% rise (fall) into a top (bottom) reversal
MIN_CUP_TREND = 0.25       # 25% advance into a cup's left rim

SHOULDER_TOLERANCE = 0.06  # shoulders within 6% in height
SHOULDER_TIME_RATIO = 2.5  # and neither side more than 2.5x as long as the other
HEAD_MARGIN = 0.03         # head at least 3% beyond both shoulders
NECK_MAX_SLOPE = 0.10      # neckline ends within 10% of each other
HS_BARS = (20, 250)        # left shoulder to right shoulder
TWIN_TOLERANCE = 0.03      # double top/bottom peaks within 3%
TWIN_MIN_DEPTH = 0.06      # middle at least 6% away
TWIN_BARS = (15, 150)
CUP_DEPTH = (0.12, 0.45)
CUP_BARS = (30, 260)
RIM_TOLERANCE = 0.05
HANDLE_DEPTH = (0.02, 0.15)
HANDLE_MAX_BARS = 40
FLAT_TOLERANCE = 0.025     # triangle's flat side: every touch within 2.5% of the mean
TRIANGLE_BARS = (25, 250)
TRIANGLE_CONVERGENCE = 0.75  # last swing range <= 75% of the first
TARGET_HORIZON = 250       # bars after the breakout to resolve hit / failed

PATTERNS = {
    "head_shoulders": ("Head and shoulders", "bear"),
    "inverse_head_shoulders": ("Inverse head and shoulders", "bull"),
    "double_top": ("Double top", "bear"),
    "double_bottom": ("Double bottom", "bull"),
    "cup_handle": ("Cup and handle", "bull"),
    "ascending_triangle": ("Ascending triangle", "bull"),
    "descending_triangle": ("Descending triangle", "bear"),
}
QUALITY_WEIGHTS = {"trend": 25, "shape": 20, "prominence": 15, "breakout": 15, "volume": 15,
                   "duration": 10}
QUALITY_TIERS = ((70, "High"), (50, "Medium"), (0, "Low"))


@dataclass
class Detection:
    symbol: str
    pattern: str
    direction: str                  # "bull" or "bear"
    start: pd.Timestamp             # first swing
    breakout: pd.Timestamp | None   # None while forming
    breakout_price: float | None
    level: float                    # neckline / rim / flat side (at the breakout, or now)
    target: float                   # level +/- pattern height (textbook measured move)
    invalidation: float             # price beyond which the pattern has failed
    quality: int = 0
    quality_reasons: list[str] = field(default_factory=list)
    status: str = "forming"         # forming | active | target_hit | failed | expired
    resolved: pd.Timestamp | None = None
    points: list[dict] = field(default_factory=list)  # swings: {time, price, label}
    line: list[dict] = field(default_factory=list)    # neckline/rim: two {time, price}
    volume_ratio: float | None = None
    trend_move: float | None = None
    bars: int = 0                   # first swing to last swing
    distance: float | None = None   # forming only: last close vs level

    @property
    def name(self) -> str:
        return PATTERNS[self.pattern][0]


@dataclass(frozen=True)
class Pivot:
    i: int
    kind: str      # "H" or "L"
    price: float


def _clip(x: float) -> float:
    return float(min(max(x, 0.0), 1.0))


def atr_pct(high: np.ndarray, low: np.ndarray, close: np.ndarray, days: int = ATR_DAYS) -> np.ndarray:
    """Average true range as a fraction of the close, per bar."""
    prev = np.r_[close[0], close[:-1]]
    tr = np.maximum.reduce([high - low, np.abs(high - prev), np.abs(low - prev)])
    atr = pd.Series(tr).rolling(days, min_periods=1).mean().to_numpy()
    return atr / close


def pivots(high: np.ndarray, low: np.ndarray, min_swing: np.ndarray | float,
           order: int = PIVOT_ORDER) -> list[Pivot]:
    """Alternating swing highs (on highs) and lows (on lows), zigzag-filtered.

    min_swing: minimum move from the previous swing, per bar or one number.
    Runs of the same kind keep the extreme.
    """
    n = len(high)
    swing = np.broadcast_to(np.asarray(min_swing, dtype=float), (n,))
    raw: list[Pivot] = []
    for i in range(order, n - order):
        hw, lw = high[i - order:i + order + 1], low[i - order:i + order + 1]
        if high[i] == hw.max() and high[i] > high[i - 1]:
            raw.append(Pivot(i, "H", float(high[i])))
        if low[i] == lw.min() and low[i] < low[i - 1]:
            raw.append(Pivot(i, "L", float(low[i])))
    out: list[Pivot] = []
    for p in raw:
        if not out:
            out.append(p)
        elif out[-1].kind == p.kind:
            better = p.price > out[-1].price if p.kind == "H" else p.price < out[-1].price
            if better:
                out[-1] = p
        elif abs(p.price / out[-1].price - 1) >= swing[p.i]:
            out.append(p)
    return out


def _line_at(a: Pivot, b: Pivot, i: int) -> float:
    if a.i == b.i:
        return a.price
    return a.price + (b.price - a.price) * (i - a.i) / (b.i - a.i)


def _close(a: float, b: float, tol: float) -> float | None:
    """How similar two prices are, 1 = equal, 0 = at the tolerance; None beyond it."""
    diff = abs(a - b) / ((a + b) / 2)
    return None if diff > tol else 1 - diff / tol


class _Stock:
    """One stock's arrays plus the helpers the templates share."""

    def __init__(self, symbol: str, bars: pd.DataFrame):
        bars = bars.dropna(subset=["close"]).sort_index()
        self.symbol = symbol
        self.dates = bars.index
        self.close = bars["close"].to_numpy(dtype=float)
        self.high = bars["high"].fillna(bars["close"]).to_numpy(dtype=float) \
            if "high" in bars else self.close
        self.low = bars["low"].fillna(bars["close"]).to_numpy(dtype=float) \
            if "low" in bars else self.close
        self.volume = bars["volume"].to_numpy(dtype=float) if "volume" in bars else None
        self.atr = atr_pct(self.high, self.low, self.close)
        swing = np.clip(SWING_ATR * self.atr, *SWING_RANGE)
        self.pivots = pivots(self.high, self.low, swing)
        self.n = len(self.close)

    def trend_into(self, first: Pivot, up: bool) -> float:
        """Rise into `first` (up=True) or fall into it, over TREND_LOOKBACK bars."""
        lo = max(0, first.i - TREND_LOOKBACK)
        if first.i <= lo:
            return 0.0
        if up:
            return first.price / self.low[lo:first.i].min() - 1
        return 1 - first.price / self.high[lo:first.i].max()

    def breakout(self, start: int, level, up: bool) -> int | None:
        for i in range(start, min(start + MAX_BREAKOUT_WAIT, self.n)):
            margin = BREAKOUT_ATR * self.atr[i] * level(i)
            if (self.close[i] > level(i) + margin) if up else (self.close[i] < level(i) - margin):
                return i
        return None

    def volume_ratio(self, i: int) -> float | None:
        if self.volume is None or i < 20:
            return None
        avg = np.nanmean(self.volume[max(0, i - 50):i])
        v = self.volume[i]
        return float(v / avg) if avg and np.isfinite(avg) and np.isfinite(v) else None

    def resolve(self, b: int, target: float, invalidation: float, up: bool):
        """(status, resolved index): which came first after the breakout."""
        for i in range(b + 1, min(b + 1 + TARGET_HORIZON, self.n)):
            if (self.high[i] >= target) if up else (self.low[i] <= target):
                return "target_hit", i
            if (self.close[i] < invalidation) if up else (self.close[i] > invalidation):
                return "failed", i
        return ("expired", None) if b + TARGET_HORIZON < self.n else ("active", None)


def _score(factors: dict[str, float]) -> int:
    return round(sum(QUALITY_WEIGHTS[k] * _clip(v) for k, v in factors.items()))


def _reasons(f: dict[str, float], facts: dict[str, str]) -> list[str]:
    """The strongest factors, in words."""
    order = sorted(f, key=lambda k: -QUALITY_WEIGHTS[k] * _clip(f[k]))
    return [facts[k] for k in order if _clip(f[k]) >= 0.5 and facts.get(k)]


def detect(symbol: str, bars: pd.DataFrame, forming: bool = False) -> list[Detection]:
    """Patterns in a stock's daily bars (close, optionally high/low/volume).

    Returns broken-out patterns, oldest first; with forming=True, also those whose
    shape is complete but haven't broken out yet (only meaningful at the data's end).
    """
    if bars is None or len(bars) < 60:
        return []
    s = _Stock(symbol, bars)
    found: list[Detection] = []
    pv = s.pivots

    def add(pattern: str, pts: list[Pivot], labels: list[str], level, up: bool,
            height: float, line_start: Pivot, invalidation: float,
            shape: dict[str, float], facts: dict[str, str], trend: float | None) -> None:
        last = pts[-1]
        b = s.breakout(last.i + PIVOT_ORDER, level, up)
        if b is None:
            still_open = last.i + PIVOT_ORDER + MAX_BREAKOUT_WAIT > s.n
            if not (forming and still_open and last.i + PIVOT_ORDER < s.n):
                return
            i = s.n - 1
        else:
            i = b
        lv = float(level(i))
        vr = s.volume_ratio(b) if b is not None else None
        f = dict(shape)
        facts = dict(facts)
        if b is not None:
            margin = abs(s.close[b] - lv) / lv / max(s.atr[b], 1e-9)  # in ATRs
            f["breakout"] = margin / 1.5
            f["volume"] = (vr - 1) if vr is not None else 0.0  # 2x average volume -> 1
            facts["breakout"] = f"broke out by {margin:.1f}× the daily range"
            facts["volume"] = f"breakout on {vr:.1f}× average volume" if vr else ""
        else:
            f["breakout"] = f["volume"] = 0.0
        d = Detection(
            symbol=symbol, pattern=pattern, direction=PATTERNS[pattern][1],
            start=s.dates[pts[0].i],
            breakout=s.dates[b] if b is not None else None,
            breakout_price=float(s.close[b]) if b is not None else None,
            level=lv, target=lv + height if up else lv - height, invalidation=invalidation,
            points=[{"time": s.dates[p.i], "price": p.price, "label": lab}
                    for p, lab in zip(pts, labels, strict=True)],
            line=[{"time": s.dates[line_start.i], "price": float(level(line_start.i))},
                  {"time": s.dates[i], "price": lv}],
            volume_ratio=vr, trend_move=trend, bars=last.i - pts[0].i,
        )
        d.quality = _score(f)
        d.quality_reasons = _reasons(f, facts)
        if b is None:
            d.status = "forming"
            d.distance = float(s.close[-1] / lv - 1)
        else:
            d.status, r = s.resolve(b, d.target, invalidation, up)
            d.resolved = s.dates[r] if r is not None else None
        found.append(d)

    def trend_fact(move: float, up: bool) -> str:
        return f"{'rose' if up else 'fell'} {move:.0%} into the pattern"

    for k in range(len(pv)):
        # Head and shoulders (H L H L H) and the inverse (L H L H L).
        if k + 5 <= len(pv):
            s1, t1, hd, t2, s2 = pv[k:k + 5]
            top = s1.kind == "H"
            heights = _close(s1.price, s2.price, SHOULDER_TOLERANCE)
            left, right = hd.i - s1.i, s2.i - hd.i
            timing = min(left, right) / max(left, right) if max(left, right) else 0
            head = (hd.price / max(s1.price, s2.price) - 1) if top \
                else (1 - hd.price / min(s1.price, s2.price))
            neck = _close(t1.price, t2.price, NECK_MAX_SLOPE)
            span = s2.i - s1.i
            if (heights is not None and neck is not None and head >= HEAD_MARGIN
                    and timing >= 1 / SHOULDER_TIME_RATIO and HS_BARS[0] <= span <= HS_BARS[1]):
                move = s.trend_into(s1, up=top)
                if move >= MIN_REVERSAL_TREND:
                    add("head_shoulders" if top else "inverse_head_shoulders",
                        [s1, t1, hd, t2, s2], ["Left shoulder", "", "Head", "", "Right shoulder"],
                        lambda i, t1=t1, t2=t2: _line_at(t1, t2, i), not top,
                        abs(hd.price - _line_at(t1, t2, hd.i)), t1, s2.price,
                        {"trend": move / (2 * MIN_REVERSAL_TREND), "shape": (heights + timing) / 2,
                         "prominence": head / 0.10, "duration": (span - HS_BARS[0]) / (2 * HS_BARS[0])},
                        {"trend": trend_fact(move, top),
                         "shape": "shoulders match in height and timing",
                         "prominence": f"head {head:.0%} beyond the shoulders",
                         "duration": f"formed over {span} trading days"},
                        move)
        # Double top (H L H) / bottom (L H L).
        if k + 3 <= len(pv):
            p1, mid, p2 = pv[k:k + 3]
            twin = _close(p1.price, p2.price, TWIN_TOLERANCE)
            top = p1.kind == "H"
            peak = (p1.price + p2.price) / 2
            depth = (1 - mid.price / peak) if top else (mid.price / peak - 1)
            span = p2.i - p1.i
            if (twin is not None and depth >= max(TWIN_MIN_DEPTH, 2 * s.atr[mid.i])
                    and TWIN_BARS[0] <= span <= TWIN_BARS[1]):
                move = s.trend_into(p1, up=top)
                if move >= MIN_REVERSAL_TREND:
                    add("double_top" if top else "double_bottom", [p1, mid, p2],
                        ["Top", "", "Top"] if top else ["Bottom", "", "Bottom"],
                        lambda i, m=mid: m.price, not top, abs(peak - mid.price), mid,
                        max(p1.price, p2.price) if top else min(p1.price, p2.price),
                        {"trend": move / (2 * MIN_REVERSAL_TREND), "shape": twin,
                         "prominence": depth / 0.15,
                         "duration": (span - TWIN_BARS[0]) / (2 * TWIN_BARS[0])},
                        {"trend": trend_fact(move, top),
                         "shape": "the two peaks match closely" if top else "the two lows match closely",
                         "prominence": f"{depth:.0%} {'dip' if top else 'rally'} between them",
                         "duration": f"{span} trading days between them"},
                        move)
        # Cup and handle: H (rim) L (cup) H (rim) L (handle).
        if k + 4 <= len(pv) and pv[k].kind == "H":
            left, bottom, right, handle = pv[k:k + 4]
            depth = 1 - bottom.price / left.price
            rim = _close(left.price, right.price, RIM_TOLERANCE)
            handle_depth = 1 - handle.price / right.price
            span = right.i - left.i
            if (rim is not None and CUP_DEPTH[0] <= depth <= CUP_DEPTH[1]
                    and CUP_BARS[0] <= span <= CUP_BARS[1]
                    and HANDLE_DEPTH[0] <= handle_depth <= HANDLE_DEPTH[1]
                    and handle.i - right.i <= HANDLE_MAX_BARS
                    and handle.price > (left.price + bottom.price) / 2):
                move = s.trend_into(left, up=True)
                if move >= MIN_CUP_TREND:
                    top_rim = max(left.price, right.price)
                    add("cup_handle", [left, bottom, right, handle],
                        ["Left rim", "Cup", "Right rim", "Handle"],
                        lambda i, r=top_rim: r, True, top_rim - bottom.price, right, handle.price,
                        {"trend": move / (2 * MIN_CUP_TREND), "shape": rim,
                         "prominence": 1 - abs(depth - 0.25) / 0.2,
                         "duration": (span - CUP_BARS[0]) / (2 * CUP_BARS[0])},
                        {"trend": trend_fact(move, True), "shape": "the two rims match",
                         "prominence": f"a {depth:.0%} deep cup",
                         "duration": f"cup took {span} trading days"},
                        move)
        # Triangles: five alternating swings, so one side has three touches.
        if k + 5 <= len(pv):
            five = pv[k:k + 5]
            highs = [p for p in five if p.kind == "H"]
            lows = [p for p in five if p.kind == "L"]
            span = five[-1].i - five[0].i
            first_range = highs[0].price - lows[0].price
            last_range = highs[-1].price - lows[-1].price
            if not (TRIANGLE_BARS[0] <= span <= TRIANGLE_BARS[1] and first_range > 0
                    and last_range <= first_range * TRIANGLE_CONVERGENCE):
                continue
            converge = 1 - last_range / first_range
            for flat, slope, up, key in ((highs, lows, True, "ascending_triangle"),
                                         (lows, highs, False, "descending_triangle")):
                mean = float(np.mean([p.price for p in flat]))
                spread = max(abs(p.price / mean - 1) for p in flat)
                steps = list(zip(slope, slope[1:], strict=False))
                trending = all(b.price > a.price * 1.01 for a, b in steps) if up \
                    else all(b.price < a.price * 0.99 for a, b in steps)
                if spread > FLAT_TOLERANCE or not trending:
                    continue
                side = max(p.price for p in flat) if up else min(p.price for p in flat)
                move = s.trend_into(five[0], up=up)
                add(key, five, [""] * 5, lambda i, v=side: v, up, abs(side - slope[0].price),
                    flat[0], slope[-1].price,
                    {"trend": move / 0.2, "shape": 1 - spread / FLAT_TOLERANCE,
                     "prominence": converge / 0.5,
                     "duration": (span - TRIANGLE_BARS[0]) / (2 * TRIANGLE_BARS[0])},
                    {"trend": f"{'rose' if up else 'fell'} {move:.0%} beforehand",
                     "shape": f"{len(flat)} touches of a flat {'top' if up else 'floor'}",
                     "prominence": "the range narrowed steadily",
                     "duration": f"formed over {span} trading days"},
                    move)
    return _one_per_formation(found)


def _one_per_formation(found: list[Detection]) -> list[Detection]:
    """Overlapping detections of the same price action keep the best-scoring one."""
    def end(d: Detection) -> pd.Timestamp:
        return d.breakout if d.breakout is not None else d.points[-1]["time"]

    kept: list[Detection] = []
    for d in sorted(found, key=lambda d: -d.quality):
        if any(k.start <= end(d) and d.start <= end(k)
               and (k.breakout is None) == (d.breakout is None) for k in kept):
            continue
        kept.append(d)
    return sorted(kept, key=lambda d: (d.breakout is None, end(d)))


COLUMNS = ["symbol", "pattern", "name", "direction", "start", "breakout", "breakout_price",
           "level", "target", "invalidation", "quality", "quality_reasons", "status", "resolved",
           "volume_ratio", "trend_move", "bars", "distance", "points", "line"]


def to_frame(detections: list[Detection]) -> pd.DataFrame:
    return pd.DataFrame([{c: (d.name if c == "name" else getattr(d, c)) for c in COLUMNS}
                         for d in detections], columns=COLUMNS)


def scan(symbols: list[str], bars, since: pd.Timestamp | None = None,
         forming: bool = False) -> pd.DataFrame:
    """Detections for many stocks; bars(symbol) -> daily bars DataFrame.

    since: only look at bars from this date (older history adds work, not insight).
    """
    out = []
    for sym in symbols:
        b = bars(sym)
        if since is not None and len(b):
            b = b[b.index >= since]
        try:
            out.extend(detect(sym, b, forming=forming))
        except Exception:  # noqa: S112 - one odd price history must not stop the scan
            continue
    return to_frame(out)


def tier(quality: float) -> str:
    return next(name for floor, name in QUALITY_TIERS if quality >= floor)


def with_promoter_context(det: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """Add promoter buying/selling in each pattern's window (start → breakout, or now).

    Per stock, cumulative sums over date-sorted trades turn each window into two
    binary searches, instead of filtering the trades once per pattern.
    """
    det = det.copy()
    if det.empty or events.empty:
        return det.assign(promoter_buys=0, promoter_net_value=0.0, promoter_buying=False)
    e = events[~events["internal_transfer"]] if "internal_transfer" in events else events
    ends = pd.DatetimeIndex(det["breakout"]).fillna(pd.Timestamp("2262-01-01")).to_numpy()
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
        lo = np.searchsorted(dates, pd.DatetimeIndex(det["start"]).to_numpy()[rows], side="left")
        hi = np.searchsorted(dates, ends[rows], side="right")
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
    day after the breakout, as everywhere else in the app. Forming patterns get NaN.
    """
    if det.empty:
        return det
    det = det.copy()
    b = bench.dropna().sort_index()
    out = {h: np.full(len(det), np.nan) for h in HORIZONS}
    broke = det["breakout"].notna().to_numpy()
    for sym, rows in det.groupby("symbol").indices.items():
        rows = rows[broke[rows]]
        if not len(rows):
            continue
        px = closes(sym).dropna().sort_index()
        if not len(px):
            continue
        values = px.to_numpy(dtype=float)
        entry = px.index.searchsorted(pd.DatetimeIndex(det["breakout"].to_numpy()[rows]), side="right")
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


def _perf(part: pd.DataFrame) -> dict:
    s60 = part["signed_60"].dropna() if len(part) else pd.Series(dtype=float)
    s20 = part["signed_20"].dropna() if len(part) else pd.Series(dtype=float)
    resolved = part[part["status"].isin(["target_hit", "failed"])] if len(part) else part
    return {
        "n": int(len(s60)),
        "mean_20": float(s20.mean()) if len(s20) else None,
        "mean_60": float(s60.mean()) if len(s60) else None,
        "median_60": float(s60.median()) if len(s60) else None,
        "worked_60": float((s60 > 0).mean()) if len(s60) else None,
        # Of patterns that resolved, the share that reached the target before failing.
        "target_hit": float((resolved["status"] == "target_hit").mean()) if len(resolved) else None,
    }


def stats(det: pd.DataFrame, min_quality: int = 0) -> list[dict]:
    """How each pattern did after its breakout: overall, by promoter buying, by quality tier."""
    broke = det[det["breakout"].notna()] if not det.empty else det
    out = []
    for key, (name, direction) in PATTERNS.items():
        g = broke[broke["pattern"] == key] if len(broke) else broke
        q = g[g["quality"] >= min_quality] if len(g) else g
        out.append({
            "pattern": key, "name": name, "direction": direction, "count": len(q),
            "all": _perf(q),
            "promoter": _perf(q[q["promoter_buying"]] if len(q) else q),
            "no_promoter": _perf(q[~q["promoter_buying"]] if len(q) else q),
            "tiers": {t: _perf(g[g["quality"].map(tier) == t] if len(g) else g)
                      for _, t in QUALITY_TIERS},
        })
    return out
