// Daily bars from the API turned into chart candles: weekly/monthly merging,
// Heikin Ashi smoothing, and lookups shared by the Stock page and the Chart page.
import type { Bar, Trade } from "../api";

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

/** Consecutive candles with the same key merged into one, dated by its first trading day. */
function mergeBy(candles: Candle[], key: (iso: string) => string): Candle[] {
  const out: Candle[] = [];
  let current = "";
  for (const c of candles) {
    const k = key(c.time);
    const last = out.at(-1);
    if (last && k === current) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume = last.volume == null || c.volume == null ? (last.volume ?? c.volume) : last.volume + c.volume;
      last.closeOnly ||= c.closeOnly;
    } else {
      out.push({ ...c });
      current = k;
    }
  }
  return out;
}

/** Daily candles merged into weekly ones, each dated by its first trading day. */
export const toWeekly = (candles: Candle[]): Candle[] => mergeBy(candles, weekKey);

/** Daily candles merged into calendar months, each dated by its first trading day. */
export const toMonthly = (candles: Candle[]): Candle[] => mergeBy(candles, (iso) => iso.slice(0, 7));

/**
 * Heikin Ashi candles: each close is the bar's OHLC average and each open the midpoint of
 * the previous Heikin Ashi candle, which smooths out noise and makes trends easier to see.
 */
export function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const prev = out.at(-1);
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    out.push({ ...c, open, close, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close) });
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

/** "2024-01-05" -> seconds since the epoch at 00:00 UTC that day. */
export function toUnix(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 1000;
}

/** Seconds since the epoch -> "2024-01-05" (UTC). */
export function fromUnix(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}
