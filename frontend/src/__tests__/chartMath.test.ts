import { describe, expect, it } from "vitest";
import { fromUnix, heikinAshi, toCandles, toMonthly, toUnix } from "../chart/candles";
import { bollinger, cleanParams, ema, indicatorLabel, macd, rsi, sma, supertrend, type Values } from "../chart/indicators";
import { DAY, TimeIndex, futureTimes } from "../chart/timeIndex";

const bar = (time: string, o: number, h: number, l: number, c: number, v = 10) => ({ time, open: o, high: h, low: l, close: c, volume: v });

function expectClose(actual: Values, expected: (number | null)[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((e, i) => (e == null ? expect(actual[i]).toBeNull() : expect(actual[i]).toBeCloseTo(e, 9)));
}

describe("candles", () => {
  it("merges daily candles into calendar months", () => {
    const months = toMonthly(
      toCandles([bar("2024-01-30", 10, 12, 9, 11), bar("2024-01-31", 11, 15, 10, 14), bar("2024-02-01", 14, 14, 8, 9)]),
    );
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({ time: "2024-01-30", open: 10, high: 15, low: 9, close: 14, volume: 20 });
    expect(months[1]).toMatchObject({ time: "2024-02-01", open: 14, close: 9 });
  });

  it("smooths candles into Heikin Ashi", () => {
    const [a, b] = heikinAshi(toCandles([bar("2024-01-01", 10, 14, 8, 12), bar("2024-01-02", 12, 16, 11, 15)]));
    expect(a).toMatchObject({ open: 11, close: 11, high: 14, low: 8 });
    expect(b).toMatchObject({ open: 11, close: 13.5, high: 16, low: 11 });
  });

  it("converts dates to UTC seconds and back", () => {
    expect(toUnix("2024-01-05")).toBe(1704412800);
    expect(fromUnix(1704412800)).toBe("2024-01-05");
  });
});

describe("time index", () => {
  const t = toUnix;
  // Thursday, Friday, then Monday.
  const idx = new TimeIndex([t("2024-01-04"), t("2024-01-05"), t("2024-01-08")], "D");

  it("maps bar times to bar indexes, and times between bars to the earlier bar", () => {
    expect(idx.toLogical(t("2024-01-05"))).toBe(1);
    expect(idx.toLogical(t("2024-01-06"))).toBe(1); // a Saturday belongs to Friday's bar
    expect(idx.toTime(2)).toBe(t("2024-01-08"));
    expect(idx.toTime(1.4)).toBe(t("2024-01-05"));
  });

  it("projects future daily bars onto weekdays", () => {
    expect(idx.toTime(3)).toBe(t("2024-01-09"));
    expect(idx.toTime(6)).toBe(t("2024-01-12")); // Friday
    expect(idx.toTime(7)).toBe(t("2024-01-15")); // then Monday
    expect(idx.toLogical(t("2024-01-15"))).toBe(7);
  });

  it("projects weekly and monthly bars", () => {
    expect(futureTimes(t("2024-01-08"), "W", 2)).toEqual([t("2024-01-15"), t("2024-01-22")]);
    expect(futureTimes(t("2024-01-02"), "M", 2)).toEqual([t("2024-02-01"), t("2024-03-01")]);
  });

  it("extrapolates before the first bar, and copes with no bars", () => {
    expect(idx.toLogical(t("2024-01-04") - 7 * DAY)).toBeCloseTo(-5);
    expect(idx.toTime(-5)).toBe(t("2023-12-28"));
    const empty = new TimeIndex([], "D");
    expect(empty.toLogical(t("2024-01-04"))).toBe(0);
    expect(empty.toTime(3)).toBe(0);
  });
});

describe("indicators", () => {
  it("computes simple and exponential moving averages", () => {
    expectClose(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
    expectClose(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
    // Leading gaps (an indicator of an indicator) are skipped before seeding.
    expectClose(ema([null, null, 2, 4, 6, 8], 2), [null, null, null, 3, 5, 7]);
  });

  it("puts Bollinger Bands k population standard deviations around the average", () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(b.mid[7]).toBe(5);
    expect(b.upper[7]).toBe(9);
    expect(b.lower[7]).toBe(1);
    expect(b.upper[6]).toBeNull();
  });

  it("scores RSI from 0 to 100 with Wilder's smoothing", () => {
    expectClose(rsi([10, 11, 10, 11], 2), [null, null, 50, 75]);
    expect(rsi([1, 2, 3, 4, 5], 3)[4]).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 3)[4]).toBe(0);
    expect(rsi([5, 5, 5, 5], 2)[3]).toBe(50);
  });

  it("computes MACD (a steady ramp gives a constant gap between the averages)", () => {
    const ramp = Array.from({ length: 60 }, (_, i) => i);
    const m = macd(ramp, 12, 26, 9);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[25]).toBeCloseTo(7);
    expect(m.macd[59]).toBeCloseTo(7);
    expect(m.signal[32]).toBeNull();
    expect(m.signal[33]).toBeCloseTo(7);
    expect(m.hist[59]).toBeCloseTo(0);
  });

  it("flips Supertrend when a close breaks through it", () => {
    const rising = Array.from({ length: 30 }, (_, i) => ({ open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i }));
    const s = supertrend([...rising, { open: 128, high: 128, low: 90, close: 90 }], 10, 3);
    expect(s.value[8]).toBeNull();
    expect(s.up[28]).toBe(true);
    expect(s.value[28]!).toBeLessThan(rising[28]!.low);
    expect(s.up[30]).toBe(false);
    expect(s.value[30]!).toBeGreaterThan(90);
  });

  it("cleans indicator settings and labels them", () => {
    expect(cleanParams("bb", [500, "x"])).toEqual([200, 2]);
    expect(cleanParams("sma", [20.4])).toEqual([20]);
    expect(indicatorLabel({ id: "a", kind: "bb", params: [20, 2], color: "#ffffff" })).toBe("BB 20 2");
  });
});
