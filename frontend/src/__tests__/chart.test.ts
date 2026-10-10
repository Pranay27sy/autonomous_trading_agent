import { describe, expect, it } from "vitest";
import type { Trade } from "../api";
import { asofIndex, toCandles, toWeekly, tradesByBar } from "../components/PriceChart";

const prices = ["2024-01-01", "2024-01-02", "2024-01-05"].map((time, i) => ({ time, close: 100 + i }));

describe("price chart markers", () => {
  it("finds the last bar on or before a date", () => {
    expect(asofIndex(prices, "2023-12-31")).toBe(-1);
    expect(asofIndex(prices, "2024-01-02")).toBe(1);
    expect(asofIndex(prices, "2024-01-04")).toBe(1); // a holiday falls back to the prior session
    expect(asofIndex(prices, "2024-02-01")).toBe(2);
  });

  it("groups trades by the bar their marker sits on", () => {
    const t = (event_date: string) => ({ event_date, direction: "buy" }) as Trade;
    const bars = tradesByBar(prices, [t("2024-01-03"), t("2024-01-02"), t("2023-01-01")]);
    expect([...bars.keys()]).toEqual(["2024-01-02"]);
    expect(bars.get("2024-01-02")).toHaveLength(2);
  });
});

describe("candles", () => {
  const bar = (time: string, o: number | null, h: number | null, l: number | null, c: number, v: number | null = 10) =>
    ({ time, open: o, high: h, low: l, close: c, volume: v });

  it("fills close-only bars so they draw as flat candles", () => {
    const [flat, full] = toCandles([bar("2024-01-01", null, null, null, 100, null), bar("2024-01-02", 99, 105, 98, 104)]);
    expect(flat).toMatchObject({ open: 100, high: 100, low: 100, close: 100, closeOnly: true });
    expect(full).toMatchObject({ open: 99, high: 105, low: 98, close: 104, closeOnly: false });
  });

  it("merges daily candles into ISO weeks", () => {
    const weeks = toWeekly(
      toCandles([
        bar("2024-01-04", 100, 110, 95, 105), // Thu
        bar("2024-01-05", 105, 120, 101, 118), // Fri
        bar("2024-01-08", 118, 119, 90, 92), // next Mon
      ]),
    );
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({ time: "2024-01-04", open: 100, high: 120, low: 95, close: 118, volume: 20 });
    expect(weeks[1]).toMatchObject({ time: "2024-01-08", open: 118, close: 92 });
  });
});
