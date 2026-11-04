// Promoter-trade markers and chart-pattern overlays, shared by the Stock page's chart
// and the full Chart page. Times are bar dates ("YYYY-MM-DD"); `timeOf` converts them
// to whatever the chart's series use.
import { LineSeries, LineStyle, type IChartApi, type ISeriesApi, type SeriesMarker, type Time } from "lightweight-charts";
import type { PatternRow, Trade } from "../api";
import { COLORS } from "../components/charts";
import { asofIndex } from "./candles";

export const PATTERN_COLORS = { bull: "#42a5f5", bear: "#ab47bc" } as const;
export const PATTERN_SHORT: Record<string, string> = {
  head_shoulders: "H&S",
  inverse_head_shoulders: "iH&S",
  double_top: "M top",
  double_bottom: "W bottom",
  cup_handle: "Cup",
  ascending_triangle: "Asc △",
  descending_triangle: "Desc △",
};

export const alpha = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

type TimeOf = (barTime: string) => Time;

/** Promoter buys (▲ below the bar) and sells (▼ above), sized by rupee value. */
export function tradeMarkers(byBar: Map<string, Trade[]>, trades: Trade[], timeOf: TimeOf): SeriesMarker<Time>[] {
  const maxValue = Math.max(...trades.map((t) => t.value ?? 0), 1);
  const markers: SeriesMarker<Time>[] = [];
  for (const [time, group] of byBar) {
    for (const side of ["buy", "sell"] as const) {
      const own = group.filter((t) => t.direction === side);
      if (!own.length) continue;
      const value = own.reduce((s, t) => s + (t.value ?? 0), 0);
      markers.push({
        time: timeOf(time),
        position: side === "buy" ? "belowBar" : "aboveBar",
        shape: side === "buy" ? "arrowUp" : "arrowDown",
        // Brighter than the candles so trades stand out against them.
        color: side === "buy" ? "#4dd0c4" : "#ff7a77",
        size: 0.8 + 1.7 * Math.sqrt(Math.min(value / maxValue, 1)),
      });
    }
  }
  return markers;
}

/** Patterns that start inside the chart's range. */
export function visiblePatterns(patterns: PatternRow[], bars: { time: string }[]): PatternRow[] {
  return patterns.filter((p) => bars.length && p.start >= bars[0]!.time);
}

/** Patterns keyed by the bar their marker sits on: the breakout, or the latest bar while forming. */
export function patternsByBar(shown: PatternRow[], bars: { time: string }[]): Map<string, PatternRow[]> {
  const out = new Map<string, PatternRow[]>();
  for (const p of shown) {
    const i = p.breakout ? asofIndex(bars, p.breakout) : bars.length - 1;
    if (i < 0) continue;
    const t = bars[i]!.time;
    out.set(t, [...(out.get(t) ?? []), p]);
  }
  return out;
}

/** A dotted line through each pattern's swing points and a dashed neckline or rim. */
export function addPatternLines(chart: IChartApi, bars: { time: string }[], shown: PatternRow[], timeOf: TimeOf): ISeriesApi<"Line">[] {
  const added: ISeriesApi<"Line">[] = [];
  const snap = (t: string) => {
    const i = asofIndex(bars, t);
    return i < 0 ? null : bars[i]!.time;
  };
  for (const p of shown) {
    const color = p.status === "forming" ? COLORS.accent : PATTERN_COLORS[p.direction];
    const quiet = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    const pts = [...new Map(p.points.map((x) => [snap(x.time), x.price])).entries()].filter(
      (e): e is [string, number] => e[0] != null,
    );
    if (pts.length > 1) {
      const swing = chart.addSeries(LineSeries, { ...quiet, color: alpha(color, 0.8), lineWidth: 1, lineStyle: LineStyle.Dotted });
      swing.setData(pts.map(([time, value]) => ({ time: timeOf(time), value })));
      added.push(swing);
    }
    const [a, b] = [snap(p.line[0]!.time), snap(p.line[1]!.time)];
    if (a && b && a < b) {
      const neck = chart.addSeries(LineSeries, { ...quiet, color, lineWidth: 1, lineStyle: LineStyle.Dashed });
      neck.setData([
        { time: timeOf(a), value: p.line[0]!.price },
        { time: timeOf(b), value: p.line[1]!.price },
      ]);
      added.push(neck);
    }
  }
  return added;
}

/** A labelled circle at each pattern's breakout bar (the latest bar while forming). */
export function patternMarkers(byBar: Map<string, PatternRow[]>, timeOf: TimeOf): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];
  for (const [time, group] of byBar) {
    for (const p of group) {
      const forming = p.status === "forming";
      markers.push({
        time: timeOf(time),
        position: p.direction === "bull" ? "belowBar" : "aboveBar",
        shape: "circle",
        color: forming ? COLORS.accent : PATTERN_COLORS[p.direction],
        size: 0.6,
        text: `${PATTERN_SHORT[p.pattern] ?? p.name}${forming ? " forming" : ""} ${p.quality}`,
      });
    }
  }
  return markers;
}
