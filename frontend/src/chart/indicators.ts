// Technical indicators computed from the chart's candles. Each returns one value per bar,
// null while there isn't enough history yet. Formulas follow the common conventions
// (Wilder smoothing for RSI and ATR, population standard deviation for Bollinger Bands).

export type Values = (number | null)[];

interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Simple moving average of the last n values. */
export function sma(values: number[], n: number): Values {
  const out: Values = values.map(() => null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first n values (leading nulls skipped). */
export function ema(values: Values, n: number): Values {
  const out: Values = values.map(() => null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += values[i]!;
  prev /= n;
  out[start + n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = start + n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Bollinger Bands: n-bar SMA plus and minus k standard deviations. */
export function bollinger(values: number[], n: number, k: number): { mid: Values; upper: Values; lower: Values } {
  const mid = sma(values, n);
  const upper: Values = [];
  const lower: Values = [];
  for (let i = 0; i < values.length; i++) {
    const m = mid[i];
    if (m == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (values[j]! - m) ** 2;
    const sd = Math.sqrt(sq / n);
    upper.push(m + k * sd);
    lower.push(m - k * sd);
  }
  return { mid, upper, lower };
}

/** Relative Strength Index (0–100) with Wilder's smoothing. */
export function rsi(values: number[], n: number): Values {
  const out: Values = values.map(() => null);
  if (values.length <= n) return out;
  const score = (gain: number, loss: number) => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = score(gain, loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = score(gain, loss);
  }
  return out;
}

/** MACD: fast EMA minus slow EMA, its signal-line EMA, and the histogram between them. */
export function macd(values: number[], fast: number, slow: number, signal: number): { macd: Values; signal: Values; hist: Values } {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Values = values.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null));
  const sig = ema(line, signal);
  const hist: Values = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i]! : null));
  return { macd: line, signal: sig, hist };
}

/** Average True Range with Wilder's smoothing. */
export function atr(bars: Ohlc[], n: number): Values {
  const out: Values = bars.map(() => null);
  if (bars.length < n) return out;
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  let prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]!) / n;
    out[i] = prev;
  }
  return out;
}

/**
 * Supertrend: a trailing stop `mult` ATRs from the bar's midpoint. It sits below the price
 * in an uptrend and flips above it when a close breaks through.
 */
export function supertrend(bars: Ohlc[], n: number, mult: number): { value: Values; up: (boolean | null)[] } {
  const range = atr(bars, n);
  const value: Values = bars.map(() => null);
  const up: (boolean | null)[] = bars.map(() => null);
  let prevUpper = NaN;
  let prevLower = NaN;
  let prevTrend = NaN;
  for (let i = 0; i < bars.length; i++) {
    const a = range[i];
    if (a == null) continue;
    const b = bars[i]!;
    const mid = (b.high + b.low) / 2;
    let upper = mid + mult * a;
    let lower = mid - mult * a;
    const prevClose = i > 0 ? bars[i - 1]!.close : NaN;
    if (!Number.isNaN(prevLower) && !(lower > prevLower || prevClose < prevLower)) lower = prevLower;
    if (!Number.isNaN(prevUpper) && !(upper < prevUpper || prevClose > prevUpper)) upper = prevUpper;
    let rising: boolean;
    if (Number.isNaN(prevTrend)) rising = false;
    else if (prevTrend === prevUpper) rising = b.close > upper;
    else rising = !(b.close < lower);
    const trend = rising ? lower : upper;
    value[i] = trend;
    up[i] = rising;
    prevUpper = upper;
    prevLower = lower;
    prevTrend = trend;
  }
  return { value, up };
}

// --- the indicator menu ------------------------------------------------------------

export type IndicatorKind = "volume" | "sma" | "ema" | "bb" | "supertrend" | "rsi" | "macd";

export interface IndicatorParam {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface IndicatorDef {
  kind: IndicatorKind;
  name: string;
  short: string;
  /** "main" draws over the price; "own" gets a pane below it. */
  pane: "main" | "own";
  params: IndicatorParam[];
  color: string;
}

export const INDICATORS: IndicatorDef[] = [
  { kind: "volume", name: "Volume", short: "Vol", pane: "main", params: [], color: "#8b95a7" },
  {
    kind: "sma",
    name: "Moving average (simple)",
    short: "SMA",
    pane: "main",
    params: [{ label: "Length", min: 2, max: 500, step: 1, value: 50 }],
    color: "#f5a524",
  },
  {
    kind: "ema",
    name: "Moving average (exponential)",
    short: "EMA",
    pane: "main",
    params: [{ label: "Length", min: 2, max: 500, step: 1, value: 20 }],
    color: "#42a5f5",
  },
  {
    kind: "bb",
    name: "Bollinger Bands",
    short: "BB",
    pane: "main",
    params: [
      { label: "Length", min: 2, max: 200, step: 1, value: 20 },
      { label: "Std dev", min: 0.5, max: 5, step: 0.1, value: 2 },
    ],
    color: "#ab47bc",
  },
  {
    kind: "supertrend",
    name: "Supertrend",
    short: "Supertrend",
    pane: "main",
    params: [
      { label: "ATR length", min: 2, max: 100, step: 1, value: 10 },
      { label: "Multiplier", min: 0.5, max: 10, step: 0.1, value: 3 },
    ],
    color: "#26a69a",
  },
  {
    kind: "rsi",
    name: "Relative Strength Index",
    short: "RSI",
    pane: "own",
    params: [{ label: "Length", min: 2, max: 100, step: 1, value: 14 }],
    color: "#ab47bc",
  },
  {
    kind: "macd",
    name: "MACD",
    short: "MACD",
    pane: "own",
    params: [
      { label: "Fast", min: 2, max: 100, step: 1, value: 12 },
      { label: "Slow", min: 3, max: 200, step: 1, value: 26 },
      { label: "Signal", min: 2, max: 100, step: 1, value: 9 },
    ],
    color: "#42a5f5",
  },
];

export const indicatorDef = (kind: IndicatorKind): IndicatorDef => INDICATORS.find((d) => d.kind === kind)!;

/** One indicator on the chart, as saved in the chart settings. */
export interface IndicatorConfig {
  id: string;
  kind: IndicatorKind;
  params: number[];
  color: string;
  hidden?: boolean;
}

/** A line (or histogram) an indicator draws, with one value per candle. */
export interface IndicatorLine {
  name: string;
  color: string;
  values: Values;
  style: "line" | "histogram" | "dashed";
  /** Per-bar colors for histograms and two-colored lines. */
  colors?: (string | null)[];
}

/** "SMA 50", "BB 20 2": the label shown in the legend. */
export function indicatorLabel(c: IndicatorConfig): string {
  const def = indicatorDef(c.kind);
  return [def.short, ...c.params.map((p) => String(p))].join(" ");
}

/** Clamp saved or typed parameters to what the indicator accepts. */
export function cleanParams(kind: IndicatorKind, params: unknown[]): number[] {
  return indicatorDef(kind).params.map((p, i) => {
    const v = Number(params[i]);
    if (!Number.isFinite(v)) return p.value;
    return Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
  }).map((v) => Number(v.toFixed(4)));
}

/** The lines an indicator draws for these candles (volume is drawn by the chart itself). */
export function computeIndicator(c: IndicatorConfig, bars: Ohlc[]): IndicatorLine[] {
  const close = bars.map((b) => b.close);
  const [p1 = 0, p2 = 0, p3 = 0] = c.params;
  switch (c.kind) {
    case "sma":
      return [{ name: "SMA", color: c.color, values: sma(close, p1), style: "line" }];
    case "ema":
      return [{ name: "EMA", color: c.color, values: ema(close, p1), style: "line" }];
    case "bb": {
      const b = bollinger(close, p1, p2);
      return [
        { name: "Upper", color: c.color, values: b.upper, style: "line" },
        { name: "Basis", color: c.color, values: b.mid, style: "dashed" },
        { name: "Lower", color: c.color, values: b.lower, style: "line" },
      ];
    }
    case "supertrend": {
      const s = supertrend(bars, p1, p2);
      return [
        { name: "Up", color: "#26a69a", values: s.value.map((v, i) => (s.up[i] ? v : null)), style: "line" },
        { name: "Down", color: "#ef5350", values: s.value.map((v, i) => (s.up[i] === false ? v : null)), style: "line" },
      ];
    }
    case "rsi":
      return [{ name: "RSI", color: c.color, values: rsi(close, p1), style: "line" }];
    case "macd": {
      const m = macd(close, p1, Math.max(p2, p1 + 1), p3);
      return [
        {
          name: "Hist",
          color: "#8b95a7",
          values: m.hist,
          style: "histogram",
          colors: m.hist.map((v, i) => {
            if (v == null) return null;
            const prev = m.hist[i - 1] ?? v;
            return v >= 0 ? (v >= prev ? "#26a69a" : "#1b6f68") : v <= prev ? "#ef5350" : "#9b3a38";
          }),
        },
        { name: "MACD", color: c.color, values: m.macd, style: "line" },
        { name: "Signal", color: "#f5a524", values: m.signal, style: "line" },
      ];
    }
    case "volume":
      return [];
  }
}
