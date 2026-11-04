// Drawings are anchored to times (UTC seconds), but the chart positions things by
// "logical" bar index. TimeIndex maps between the two, including the empty space to the
// right of the last bar, so lines can be drawn into the future like on any trading chart.

export type Interval = "D" | "W" | "M";

export const DAY = 86_400;
/** Bar times projected past the last bar; beyond that the step is extrapolated. */
const FUTURE_BARS = 500;
/** Latest time a drawing may use (the API refuses anything after 2100). */
export const MAX_TIME = 4_102_444_799;

/** The next `n` bar times after `last`: weekdays for daily bars, a week or a month apart otherwise. */
export function futureTimes(last: number, interval: Interval, n: number): number[] {
  const out: number[] = [];
  const start = new Date(last * 1000);
  let t = last;
  for (let i = 1; i <= n; i++) {
    if (interval === "D") {
      do t += DAY;
      while ([0, 6].includes(new Date(t * 1000).getUTCDay()));
    } else if (interval === "W") {
      t += 7 * DAY;
    } else {
      t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1) / 1000;
    }
    out.push(t);
  }
  return out;
}

export class TimeIndex {
  /** Number of real bars; logical indexes from here on are projected. */
  readonly bars: number;
  private readonly times: number[];
  /** Seconds per bar, for extrapolating before the first bar or past the projection. */
  private readonly step: number;

  constructor(barTimes: number[], interval: Interval) {
    this.bars = barTimes.length;
    const last = barTimes.at(-1);
    this.times = last == null ? [] : [...barTimes, ...futureTimes(last, interval, FUTURE_BARS)];
    this.step = interval === "D" ? (DAY * 7) / 5 : interval === "W" ? 7 * DAY : 30.44 * DAY;
  }

  /**
   * Logical index of the bar containing `t`: a whole number from the first bar on (a time
   * between two bars belongs to the earlier one), fractional before the first bar.
   */
  toLogical(t: number): number {
    const ts = this.times;
    const n = ts.length;
    if (!n) return 0;
    if (t < ts[0]!) return (t - ts[0]!) / this.step;
    if (t >= ts[n - 1]!) return n - 1 + Math.round((t - ts[n - 1]!) / this.step);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Time of the bar at a logical index, rounded to a whole bar. */
  toTime(logical: number): number {
    const ts = this.times;
    const n = ts.length;
    if (!n) return 0;
    const i = Math.round(logical);
    let t: number;
    if (i < 0) t = ts[0]! + i * this.step;
    else if (i >= n) t = ts[n - 1]! + (i - n + 1) * this.step;
    else return ts[i]!;
    return Math.min(Math.max(Math.round(t / DAY) * DAY, 0), MAX_TIME);
  }
}
