import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Bar, PatternRow, Trade } from "../api";
import { day, inr, integer, percentPoints, price as fmtPrice } from "../format";
import { COLORS } from "./charts";

export type Interval = "D" | "W";

/** A bar with every OHLC field filled in. */
export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** True when the source bar only had a close (cached before candles were stored). */
  closeOnly: boolean;
}

export function toCandles(bars: Bar[]): Candle[] {
  return bars.map((b) => {
    const closeOnly = b.open == null || b.high == null || b.low == null;
    return {
      time: b.time,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
      volume: b.volume,
      closeOnly,
    };
  });
}

/** Monday of the ISO week a YYYY-MM-DD date falls in. */
function weekKey(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Daily candles merged into weekly ones, each dated by its first trading day. */
export function toWeekly(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  let key = "";
  for (const c of candles) {
    const k = weekKey(c.time);
    const last = out.at(-1);
    if (last && k === key) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume = last.volume == null || c.volume == null ? (last.volume ?? c.volume) : last.volume + c.volume;
      last.closeOnly ||= c.closeOnly;
    } else {
      out.push({ ...c });
      key = k;
    }
  }
  return out;
}

/** Index of the last bar on or before `date` (bars sorted by time), or -1. */
export function asofIndex(bars: { time: string }[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Trades grouped by the bar their marker sits on (disclosures can land on holidays). */
export function tradesByBar(bars: { time: string }[], trades: Trade[]): Map<string, Trade[]> {
  const out = new Map<string, Trade[]>();
  for (const t of trades) {
    const i = asofIndex(bars, t.event_date);
    if (i < 0) continue;
    const bar = bars[i]!.time;
    out.set(bar, [...(out.get(bar) ?? []), t]);
  }
  return out;
}

const PATTERN_COLORS = { bull: "#42a5f5", bear: "#ab47bc" } as const;
const PATTERN_SHORT: Record<string, string> = {
  head_shoulders: "H&S",
  inverse_head_shoulders: "iH&S",
  double_top: "M top",
  double_bottom: "W bottom",
  cup_handle: "Cup",
  ascending_triangle: "Asc △",
  descending_triangle: "Desc △",
};

const alpha = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

/**
 * Japanese candlesticks with volume, plus promoter buys (▲ below the bar) and
 * sells (▼ above), sized by rupee value.
 */
export function PriceChart({
  bars,
  trades,
  interval,
  patterns = [],
}: {
  bars: Bar[];
  trades: Trade[];
  interval: Interval;
  /** Detected chart patterns to draw: swing points, the neckline/rim, and a breakout marker. */
  patterns?: PatternRow[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ candle: Candle; trades: Trade[]; patterns: PatternRow[] } | null>(null);
  const candles = useMemo(() => {
    const daily = toCandles(bars);
    return interval === "W" ? toWeekly(daily) : daily;
  }, [bars, interval]);
  const byBar = useMemo(() => tradesByBar(candles, trades), [candles, trades]);
  // Only patterns that break out inside the chart's range, keyed by their breakout bar.
  const shown = useMemo(() => patterns.filter((p) => candles.length && p.start >= candles[0]!.time), [patterns, candles]);
  const patternsByBar = useMemo(() => {
    const out = new Map<string, PatternRow[]>();
    for (const p of shown) {
      // Forming patterns are marked on the latest bar.
      const i = p.breakout ? asofIndex(candles, p.breakout) : candles.length - 1;
      if (i < 0) continue;
      const t = candles[i]!.time;
      out.set(t, [...(out.get(t) ?? []), p]);
    }
    return out;
  }, [shown, candles]);

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.muted,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.grid, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: COLORS.grid, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (p: number) => fmtPrice(p) },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.buy,
      downColor: COLORS.sell,
      wickUpColor: COLORS.buy,
      wickDownColor: COLORS.sell,
      borderVisible: false,
      priceLineVisible: false,
    });
    candle.setData(candles.map((c) => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })));

    // Volume as a histogram along the bottom fifth, on its own scale.
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(
      candles
        .filter((c) => c.volume != null)
        .map((c) => ({
          time: c.time as Time,
          value: c.volume!,
          color: alpha(c.close >= c.open ? COLORS.buy : COLORS.sell, 0.35),
        })),
    );

    const maxValue = Math.max(...trades.map((t) => t.value ?? 0), 1);
    const markers: SeriesMarker<Time>[] = [];
    for (const [time, group] of byBar) {
      for (const side of ["buy", "sell"] as const) {
        const own = group.filter((t) => t.direction === side);
        if (!own.length) continue;
        const value = own.reduce((s, t) => s + (t.value ?? 0), 0);
        markers.push({
          time: time as Time,
          position: side === "buy" ? "belowBar" : "aboveBar",
          shape: side === "buy" ? "arrowUp" : "arrowDown",
          // Brighter than the candles so trades stand out against them.
          color: side === "buy" ? "#4dd0c4" : "#ff7a77",
          size: 0.8 + 1.7 * Math.sqrt(Math.min(value / maxValue, 1)),
        });
      }
    }
    // Patterns: dotted line through the swing points, dashed neckline/rim, labelled breakout.
    const snap = (t: string) => {
      const i = asofIndex(candles, t);
      return i < 0 ? null : candles[i]!.time;
    };
    for (const p of shown) {
      const color = p.status === "forming" ? COLORS.accent : PATTERN_COLORS[p.direction];
      const quiet = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
      const pts = [...new Map(p.points.map((x) => [snap(x.time), x.price])).entries()].filter(
        (e): e is [string, number] => e[0] != null,
      );
      if (pts.length > 1) {
        const swing = chart.addSeries(LineSeries, { ...quiet, color: alpha(color, 0.8), lineWidth: 1, lineStyle: LineStyle.Dotted });
        swing.setData(pts.map(([time, value]) => ({ time: time as Time, value })));
      }
      const [a, b] = [snap(p.line[0]!.time), snap(p.line[1]!.time)];
      if (a && b && a < b) {
        const neck = chart.addSeries(LineSeries, { ...quiet, color, lineWidth: 1, lineStyle: LineStyle.Dashed });
        neck.setData([
          { time: a as Time, value: p.line[0]!.price },
          { time: b as Time, value: p.line[1]!.price },
        ]);
      }
    }
    for (const [time, group] of patternsByBar) {
      for (const p of group) {
        const forming = p.status === "forming";
        markers.push({
          time: time as Time,
          position: p.direction === "bull" ? "belowBar" : "aboveBar",
          shape: "circle",
          color: forming ? COLORS.accent : PATTERN_COLORS[p.direction],
          size: 0.6,
          text: `${PATTERN_SHORT[p.pattern] ?? p.name}${forming ? " forming" : ""} ${p.quality}`,
        });
      }
    }
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    createSeriesMarkers(candle, markers);

    // Open on the latest ~6 months of daily candles (~2 years of weekly); scroll for more.
    const visible = interval === "W" ? 104 : 130;
    if (candles.length > visible) {
      chart.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + 3 });
    } else {
      chart.timeScale().fitContent();
    }

    const byTime = new Map(candles.map((c) => [c.time, c]));
    chart.subscribeCrosshairMove((param) => {
      const c = param.time && param.point ? byTime.get(String(param.time)) : undefined;
      setTip(c ? { candle: c, trades: byBar.get(c.time) ?? [], patterns: patternsByBar.get(c.time) ?? [] } : null);
    });
    return () => chart.remove();
  }, [candles, trades, byBar, interval, shown, patternsByBar]);

  const c = tip?.candle;
  const change = c ? c.close / c.open - 1 : 0;
  return (
    <div className="chart-box" ref={box} role="img" aria-label="Candlestick chart with promoter trades">
      {c && tip && (
        <div className="chart-tip">
          <div className="mono">
            {interval === "W" ? "Week of " : ""}
            {day(c.time)}
          </div>
          {c.closeOnly ? (
            <div className="row mono">C {fmtPrice(c.close)}</div>
          ) : (
            <div className="row mono" style={{ flexWrap: "wrap", columnGap: 10 }}>
              <span>O {fmtPrice(c.open)}</span>
              <span>H {fmtPrice(c.high)}</span>
              <span>L {fmtPrice(c.low)}</span>
              <span>C {fmtPrice(c.close)}</span>
              <span className={change >= 0 ? "pos" : "neg"}>
                {change >= 0 ? "+" : "−"}
                {Math.abs(change * 100).toFixed(2)}%
              </span>
            </div>
          )}
          {c.volume != null && <div className="row muted mono">Vol {integer(c.volume)}</div>}
          {tip.trades.slice(0, 4).map((t, i) => (
            <div className="row" key={i}>
              <span className={`chip ${t.direction}`}>{t.direction}</span>
              <span className="mono">{inr(t.value)}</span>
              <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.person} · Δ {percentPoints(t.holding_change_pct, 2, true)}%
              </span>
            </div>
          ))}
          {tip.trades.length > 4 && <div className="muted">+{tip.trades.length - 4} more</div>}
          {tip.patterns.map((p) => (
            <div className="row" key={p.pattern}>
              <span className="chip" style={{ color: PATTERN_COLORS[p.direction], background: alpha(PATTERN_COLORS[p.direction], 0.15) }}>
                {p.direction === "bull" ? "↑" : "↓"} pattern
              </span>
              <span>
                {p.status === "forming"
                  ? `${p.name} forming: breaks at ${fmtPrice(p.level)}`
                  : `${p.name} breakout through ${fmtPrice(p.level)} · target ${fmtPrice(p.target)} · ${p.status.replace("_", " ")}`}{" "}
                · quality {p.quality}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
