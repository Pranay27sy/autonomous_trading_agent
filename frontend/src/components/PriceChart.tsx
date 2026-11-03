import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Bar, PatternRow, Trade } from "../api";
import { toCandles, toWeekly, tradesByBar, type Candle } from "../chart/candles";
import {
  PATTERN_COLORS,
  addPatternLines,
  alpha,
  patternMarkers,
  patternsByBar as groupPatterns,
  tradeMarkers,
  visiblePatterns,
} from "../chart/overlays";
import { day, inr, integer, percentPoints, price as fmtPrice } from "../format";
import { COLORS } from "./charts";

export type Interval = "D" | "W";

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
  const shown = useMemo(() => visiblePatterns(patterns, candles), [patterns, candles]);
  const patternsByBar = useMemo(() => groupPatterns(shown, candles), [shown, candles]);

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

    const timeOf = (t: string) => t as Time;
    addPatternLines(chart, candles, shown, timeOf);
    const markers = [...tradeMarkers(byBar, trades, timeOf), ...patternMarkers(patternsByBar, timeOf)];
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
