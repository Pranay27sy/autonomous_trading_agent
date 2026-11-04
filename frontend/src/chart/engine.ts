// The Chart page's chart: Lightweight Charts plus candles in any interval and style,
// indicators (on the price or in panes below it), promoter-trade and pattern markers,
// the drawing tools, zooming, and screenshots. React drives it through update().
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Logical,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, PatternRow, Trade } from "../api";
import { COLORS } from "../components/charts";
import { day, price as fmtPrice } from "../format";
import { fromUnix, heikinAshi, toCandles, toMonthly, toUnix, toWeekly, tradesByBar, type Candle } from "./candles";
import { DrawingController, type ControllerHost } from "./controller";
import type { P, Viewport } from "./drawings";
import { computeIndicator, indicatorDef, type IndicatorConfig, type IndicatorLine } from "./indicators";
import { addPatternLines, alpha, patternMarkers, patternsByBar, tradeMarkers, visiblePatterns } from "./overlays";
import { FONTS, DrawingsPrimitive } from "./primitive";
import { TimeIndex, type Interval } from "./timeIndex";

export type ChartType = "candles" | "hollow" | "bars" | "heikin" | "line" | "area";
export type ScaleMode = "linear" | "log" | "percent";
export type RangeKey = "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "All";

export const CHART_TYPES: { key: ChartType; label: string }[] = [
  { key: "candles", label: "Candles" },
  { key: "hollow", label: "Hollow candles" },
  { key: "bars", label: "Bars (OHLC)" },
  { key: "heikin", label: "Heikin Ashi" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
];

export interface ChartInput {
  symbol: string;
  /** Daily bars from the API. */
  bars: Bar[];
  interval: Interval;
  type: ChartType;
  scale: ScaleMode;
  indicators: IndicatorConfig[];
  trades: Trade[];
  showTrades: boolean;
  patterns: PatternRow[];
  showPatterns: boolean;
}

/** An indicator as drawn: its lines, and the pane they're in. */
export interface DrawnIndicator {
  config: IndicatorConfig;
  lines: IndicatorLine[];
  pane: number;
}

type Host = Pick<ControllerHost, "changed" | "stateChanged" | "editText">;

/** Bars on screen when a chart opens or the view is reset. */
const DEFAULT_BARS: Record<Interval, number> = { D: 130, W: 104, M: 120 };
/** How far back each range button goes: [years, months]. */
const RANGE_BACK: Record<Exclude<RangeKey, "All">, [number, number]> = {
  "1M": [0, 1],
  "3M": [0, 3],
  "6M": [0, 6],
  YTD: [0, 0],
  "1Y": [1, 0],
  "5Y": [5, 0],
};
const BLUE = "#42a5f5";
const RUPEES = { type: "custom", formatter: (p: number) => fmtPrice(p), minMove: 0.01 } as const;

let measureCtx: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, size: number, font: "sans" | "mono"): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * size * 0.6;
  measureCtx.font = `${size}px ${FONTS[font]}`;
  return measureCtx.measureText(text).width;
}

export class ChartEngine {
  readonly chart: IChartApi;
  readonly ctl: DrawingController;
  /** Candles as displayed (after the interval and Heikin Ashi). */
  candles: Candle[] = [];
  /** Trades keyed by the date of the candle they're marked on. */
  byBar = new Map<string, Trade[]>();
  indicators: DrawnIndicator[] = [];
  /** Index of the candle under the crosshair; null shows the latest. */
  hover: number | null = null;
  /** False once the user scrolls back from the latest bar. */
  atLatest = true;
  /** Bumped on every change the page shows, crosshair moves included (the legend). */
  version = 0;
  /** Bumped on changes the toolbars show: tool, selection, history, data, scroll. */
  uiVersion = 0;

  private input: ChartInput | null = null;
  private index = new TimeIndex([], "D");
  private times: number[] = [];
  private byTime = new Map<number, number>();
  private main: ISeriesApi<SeriesType> | null = null;
  private extras: ISeriesApi<SeriesType>[] = [];
  private patternLines: ISeriesApi<"Line">[] = [];
  private markers: ISeriesMarkersPluginApi<Time> | null = null;
  private readonly primitive: DrawingsPrimitive;
  private readonly listeners = new Set<() => void>();
  private readonly unbind: () => void;

  constructor(private readonly el: HTMLElement, host: Host) {
    this.chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: COLORS.muted,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 11,
        panes: { separatorColor: COLORS.grid, separatorHoverColor: "rgba(245, 165, 36, 0.25)", enableResize: true },
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.grid },
      timeScale: { borderColor: COLORS.grid, rightOffset: 8, minBarSpacing: 0.1 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    this.ctl = new DrawingController({
      ...host,
      stateChanged: () => {
        host.stateChanged();
        this.emit();
      },
      viewport: () => this.viewport(),
      repaint: () => this.primitive.update(),
      zoomTo: (a, b) => this.zoomToBox(a, b),
    });
    this.primitive = new DrawingsPrimitive(this.ctl, () => this.viewport(), (t) => day(fromUnix(t), true));
    this.chart.subscribeCrosshairMove(this.onCrosshair);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
    this.unbind = this.bindPointer();
  }

  destroy(): void {
    this.unbind();
    this.chart.remove();
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(ui = true): void {
    this.version += 1;
    if (ui) this.uiVersion += 1;
    for (const fn of this.listeners) fn();
  }

  // --- data -------------------------------------------------------------------------

  update(next: ChartInput): void {
    const prev = this.input;
    this.input = next;
    const newSymbol = prev?.symbol !== next.symbol;
    const dataChanged = !prev || prev.bars !== next.bars || prev.interval !== next.interval;
    const restyled = !prev || prev.type !== next.type;
    // Switching interval keeps the same stretch of time on screen.
    const keep = !newSymbol && dataChanged ? this.visibleTimes() : null;

    if (dataChanged || restyled) {
      const daily = toCandles(next.bars);
      const merged = next.interval === "W" ? toWeekly(daily) : next.interval === "M" ? toMonthly(daily) : daily;
      this.candles = next.type === "heikin" ? heikinAshi(merged) : merged;
      this.times = this.candles.map((c) => toUnix(c.time));
      this.byTime = new Map(this.times.map((t, i) => [t, i]));
      this.index = new TimeIndex(this.times, next.interval);
      this.hover = null;
      this.buildMain();
    }
    if (dataChanged || restyled || prev.indicators !== next.indicators) this.buildIndicators();
    if (
      dataChanged || restyled || prev.trades !== next.trades || prev.showTrades !== next.showTrades ||
      prev.patterns !== next.patterns || prev.showPatterns !== next.showPatterns
    ) {
      this.byBar = tradesByBar(this.candles, next.trades);
      this.buildMarkers();
    }
    if (!prev || prev.scale !== next.scale) {
      const mode = { linear: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage }[next.scale];
      this.chart.priceScale("right").applyOptions({ mode, autoScale: true });
    }
    if (newSymbol) this.resetView();
    else if (keep) this.showTimes(keep);
    this.primitive.update();
    this.emit();
  }

  private buildMain(): void {
    const type = this.input!.type;
    if (this.main) {
      this.main.detachPrimitive(this.primitive);
      this.markers?.detach();
      this.markers = null;
      this.chart.removeSeries(this.main);
    }
    const time = (c: Candle) => toUnix(c.time) as UTCTimestamp;
    const ohlc = this.candles.map((c) => ({ time: time(c), open: c.open, high: c.high, low: c.low, close: c.close }));
    const closes = this.candles.map((c) => ({ time: time(c), value: c.close }));
    const candleColors = { upColor: COLORS.buy, downColor: COLORS.sell, wickUpColor: COLORS.buy, wickDownColor: COLORS.sell, priceFormat: RUPEES };
    let s: ISeriesApi<SeriesType>;
    if (type === "candles" || type === "heikin") {
      s = this.chart.addSeries(CandlestickSeries, { ...candleColors, borderVisible: false });
      s.setData(ohlc);
    } else if (type === "hollow") {
      s = this.chart.addSeries(CandlestickSeries, {
        ...candleColors,
        upColor: "rgba(0, 0, 0, 0)",
        borderVisible: true,
        borderUpColor: COLORS.buy,
        borderDownColor: COLORS.sell,
      });
      s.setData(ohlc);
    } else if (type === "bars") {
      s = this.chart.addSeries(BarSeries, { upColor: COLORS.buy, downColor: COLORS.sell, thinBars: false, priceFormat: RUPEES });
      s.setData(ohlc);
    } else if (type === "line") {
      s = this.chart.addSeries(LineSeries, { color: BLUE, lineWidth: 2, priceFormat: RUPEES });
      s.setData(closes);
    } else {
      s = this.chart.addSeries(AreaSeries, {
        lineColor: BLUE,
        topColor: "rgba(66, 165, 245, 0.32)",
        bottomColor: "rgba(66, 165, 245, 0.02)",
        lineWidth: 2,
        priceFormat: RUPEES,
      });
      s.setData(closes);
    }
    s.attachPrimitive(this.primitive);
    this.main = s;
  }

  private buildIndicators(): void {
    for (const s of this.extras) this.chart.removeSeries(s); // emptied panes go with them
    this.extras = [];
    this.indicators = [];
    const times = this.times as UTCTimestamp[];
    let volumeOn = false;
    let pane = 0;
    for (const config of this.input!.indicators) {
      if (config.hidden) {
        this.indicators.push({ config, lines: [], pane: -1 });
        continue;
      }
      if (config.kind === "volume") {
        volumeOn = true;
        const vol = this.chart.addSeries(HistogramSeries, {
          priceScaleId: "volume",
          priceFormat: { type: "volume" },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(
          this.candles.flatMap((c, i) =>
            c.volume == null ? [] : [{ time: times[i]!, value: c.volume, color: alpha(c.close >= c.open ? COLORS.buy : COLORS.sell, 0.35) }],
          ),
        );
        vol.setSeriesOrder(0); // behind the candles
        this.extras.push(vol);
        const values = this.candles.map((c) => c.volume);
        this.indicators.push({ config, lines: [{ name: "Vol", color: COLORS.muted, values, style: "histogram" }], pane: 0 });
        continue;
      }
      const lines = computeIndicator(config, this.candles);
      const own = indicatorDef(config.kind).pane === "own";
      const paneIndex = own ? ++pane : 0;
      lines.forEach((line, n) => {
        const data = times.map((time, i) => {
          const v = line.values[i];
          if (v == null) return { time };
          const color = line.colors?.[i];
          return color ? { time, value: v, color } : { time, value: v };
        });
        const quiet = {
          priceLineVisible: false,
          lastValueVisible: own || lines.length === 1,
          crosshairMarkerVisible: false,
          // Lines on the price read in rupees; RSI and MACD are plain numbers.
          priceFormat: own ? ({ type: "price", precision: 2, minMove: 0.01 } as const) : RUPEES,
        };
        const s =
          line.style === "histogram"
            ? this.chart.addSeries(HistogramSeries, { ...quiet, color: line.color }, paneIndex)
            : this.chart.addSeries(
                LineSeries,
                {
                  ...quiet,
                  color: line.color,
                  lineWidth: lines.length > 1 && config.kind !== "supertrend" ? 1 : 2,
                  lineStyle: line.style === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
                },
                paneIndex,
              );
        s.setData(data);
        if (config.kind === "rsi" && n === 0) {
          for (const level of [70, 30]) {
            s.createPriceLine({ price: level, color: COLORS.faint, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
          }
          s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
        }
        this.extras.push(s);
      });
      this.indicators.push({ config, lines, pane: paneIndex });
    }
    this.chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: volumeOn ? 0.22 : 0.08 } });
    // Oscillator panes each get about a quarter of the price pane's height.
    this.chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 1 : 0.3));
  }

  private buildMarkers(): void {
    for (const s of this.patternLines) this.chart.removeSeries(s);
    const input = this.input!;
    const timeOf = (t: string) => toUnix(t) as UTCTimestamp;
    const shown = input.showPatterns ? visiblePatterns(input.patterns, this.candles) : [];
    this.patternLines = shown.length ? addPatternLines(this.chart, this.candles, shown, timeOf) : [];
    const markers = [
      ...(input.showTrades ? tradeMarkers(this.byBar, input.trades, timeOf) : []),
      ...patternMarkers(patternsByBar(shown, this.candles), timeOf),
    ].sort((a, b) => (a.time as number) - (b.time as number));
    if (this.markers) this.markers.setMarkers(markers);
    else if (this.main) this.markers = createSeriesMarkers(this.main, markers);
  }

  // --- view -------------------------------------------------------------------------

  /** The default view: the latest few months of bars, prices auto-fitted. */
  resetView(): void {
    const n = this.candles.length;
    if (!n) return;
    const span = DEFAULT_BARS[this.input?.interval ?? "D"];
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(n - span, -2), to: n + 6 });
    this.chart.priceScale("right").setAutoScale(true);
  }

  fitAll(): void {
    this.chart.timeScale().fitContent();
    this.chart.priceScale("right").setAutoScale(true);
  }

  autoScale(): void {
    this.chart.priceScale("right").setAutoScale(true);
  }

  /** Zoom the time axis: factor < 1 zooms in. Keeps the latest bar in place if it's on screen. */
  zoom(factor: number): void {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    const n = this.candles.length;
    if (!r || !n) return;
    const width = Math.min(Math.max((r.to - r.from) * factor, 10), Math.max(n * 1.1, 60));
    const pinRight = r.to >= n - 1;
    const from = pinRight ? r.to - width : (r.from + r.to) / 2 - width / 2;
    ts.setVisibleLogicalRange({ from, to: from + width });
  }

  showRange(range: RangeKey): void {
    const n = this.candles.length;
    if (!n) return;
    if (range === "All") return this.fitAll();
    const last = new Date(this.times[n - 1]! * 1000);
    const [y, m, d] = [last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()];
    const [years, months] = RANGE_BACK[range];
    const from = (range === "YTD" ? Date.UTC(y, 0, 1) : Date.UTC(y - years, m - months, d)) / 1000;
    // First bar on or after `from`.
    let first = Math.floor(this.index.toLogical(from));
    if (first < 0 || this.times[first] !== from) first += 1;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(first, 0) - 0.5, to: n - 1 + 4 });
    this.chart.priceScale("right").setAutoScale(true);
  }

  scrollToLatest(): void {
    this.chart.timeScale().scrollToRealTime();
  }

  private visibleTimes(): [number, number] | null {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    return r && this.times.length ? [this.index.toTime(r.from), this.index.toTime(r.to)] : null;
  }

  private showTimes([from, to]: [number, number]): void {
    const a = this.index.toLogical(from);
    const b = Math.max(this.index.toLogical(to), a + 10);
    this.chart.timeScale().setVisibleLogicalRange({ from: a, to: b });
  }

  /**
   * Zoom to a box dragged with the zoom tool: time, and price on a linear scale. (On log
   * scales the library's setVisibleRange takes log-space values, so price stays auto-fitted.)
   */
  private zoomToBox(a: P, b: P): void {
    const main = this.main;
    const ts = this.chart.timeScale();
    const [l1, l2] = [ts.coordinateToLogical(Math.min(a.x, b.x)), ts.coordinateToLogical(Math.max(a.x, b.x))];
    if (!main || l1 == null || l2 == null) return;
    const [p1, p2] = [main.coordinateToPrice(Math.min(a.y, b.y)), main.coordinateToPrice(Math.max(a.y, b.y))];
    ts.setVisibleLogicalRange({ from: l1, to: Math.max(l2, l1 + 5) });
    const scale = this.chart.priceScale("right");
    if (this.input?.scale === "linear" && p1 != null && p2 != null && Math.abs(b.y - a.y) > 8) {
      scale.setAutoScale(false);
      scale.setVisibleRange({ from: Math.min(p1, p2), to: Math.max(p1, p2) });
    } else scale.setAutoScale(true);
  }

  /** Save the chart (with drawings) as a PNG, titled like the legend. */
  screenshot(fileName: string, title: string): void {
    const shot = this.chart.takeScreenshot(true, false);
    const out = document.createElement("canvas");
    out.width = shot.width;
    out.height = shot.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(shot, 0, 0);
    const ratio = shot.width / Math.max(this.el.clientWidth, 1);
    ctx.font = `600 ${13 * ratio}px ${FONTS.mono}`;
    ctx.fillStyle = "rgba(11, 14, 20, 0.8)";
    ctx.fillRect(0, 0, (ctx.measureText(title).width + 20 * ratio), 26 * ratio);
    ctx.fillStyle = "#e6e9ef";
    ctx.textBaseline = "middle";
    ctx.fillText(title, 10 * ratio, 13 * ratio);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, "image/png");
  }

  /** Top of a pane, in pixels from the top of the chart (for its legend). */
  paneTop(index: number): number {
    const row = this.chart.panes()[index]?.getHTMLElement();
    return row ? row.getBoundingClientRect().top - this.el.getBoundingClientRect().top : 0;
  }

  // --- drawings ---------------------------------------------------------------------

  viewport(): Viewport | null {
    const main = this.main;
    const candles = this.candles;
    if (!main || !candles.length) return null;
    const ts = this.chart.timeScale();
    const size = this.chart.paneSize(0);
    const index = this.index;
    return {
      width: size.width,
      height: size.height,
      logical: (t) => index.toLogical(t),
      timeAt: (l) => index.toTime(l),
      xAt: (l) => ts.logicalToCoordinate(l as Logical) ?? NaN,
      logicalAt: (x) => ts.coordinateToLogical(x) ?? NaN,
      y: (p) => main.priceToCoordinate(p) ?? NaN,
      price: (y) => main.coordinateToPrice(y) ?? NaN,
      bar: (l) => {
        const c = candles[Math.round(l)];
        if (!c) return undefined;
        // Line and area charts only show the close.
        const lineOnly = this.input?.type === "line" || this.input?.type === "area";
        return lineOnly ? { open: c.close, high: c.close, low: c.close, close: c.close } : c;
      },
      formatPrice: (p) => fmtPrice(p),
      measureText,
    };
  }

  /** Feed mouse/touch input on the price pane to the drawing controller. */
  private bindPointer(): () => void {
    const el = this.el;
    let consumed = false;
    let pressed = false;
    const local = (e: { clientX: number; clientY: number }): P | null => {
      const row = this.chart.panes()[0]?.getHTMLElement();
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: e.clientX - r.left - this.chart.priceScale("left").width(), y: e.clientY - r.top };
    };
    const inPane = (p: P) => {
      const s = this.chart.paneSize(0);
      return p.x >= 0 && p.y >= 0 && p.x <= s.width && p.y <= s.height;
    };
    const onDragMove = (e: PointerEvent) => {
      const p = local(e);
      if (p) this.ctl.move(p, true);
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      pressed = consumed = false;
      const p = local(e);
      if (p) this.ctl.up(p);
    };
    const onDown = (e: PointerEvent) => {
      consumed = false;
      if (e.button !== 0 || !e.isPrimary) return;
      const p = local(e);
      if (!p) return;
      if (!inPane(p)) {
        this.ctl.deselect(); // e.g. a click in an indicator pane or on an axis
        return;
      }
      consumed = this.ctl.down(p);
      if (!consumed) return;
      pressed = true;
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    // The chart pans on mousedown/touchstart, which follow pointerdown: keep them from it
    // when the press is drawing.
    const stopIfDrawing = (e: Event) => {
      if (!consumed) return;
      e.stopPropagation();
      if (e.type === "mousedown") e.preventDefault(); // no text selection while dragging
    };
    const onHover = (e: PointerEvent) => {
      if (pressed) return;
      const p = local(e);
      if (p) this.ctl.move(p, false);
    };
    const onLeave = () => {
      if (!pressed) this.ctl.leave();
    };
    const onDouble = (e: MouseEvent) => {
      const p = local(e);
      if (p && inPane(p) && this.ctl.doubleClick(p)) e.stopPropagation();
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("mousedown", stopIfDrawing, true);
    el.addEventListener("touchstart", stopIfDrawing, { capture: true, passive: true });
    el.addEventListener("pointermove", onHover);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("dblclick", onDouble, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("mousedown", stopIfDrawing, true);
      el.removeEventListener("touchstart", stopIfDrawing, true);
      el.removeEventListener("pointermove", onHover);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("dblclick", onDouble, true);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }

  private onCrosshair = (param: MouseEventParams<Time>) => {
    const i = param.point && typeof param.time === "number" ? (this.byTime.get(param.time) ?? null) : null;
    if (i !== this.hover) {
      this.hover = i;
      this.emit(false);
    }
  };

  private onRange = () => {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const atLatest = !r || r.to >= this.candles.length - 1;
    if (atLatest !== this.atLatest) {
      this.atLatest = atLatest;
      this.emit();
    }
  };
}
