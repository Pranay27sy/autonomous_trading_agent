import { describe, expect, it } from "vitest";
import { ago, day, inr, pct, percentPoints } from "../format";

describe("format", () => {
  it("shows rupees in crore and lakh", () => {
    expect(inr(1.2e10)).toBe("₹1,200 cr");
    expect(inr(2.35e7)).toBe("₹2.4 cr");
    expect(inr(4.5e6)).toBe("₹45.0 L");
    expect(inr(-2.3e7, true)).toBe("−₹2.3 cr");
    expect(inr(5e7, true)).toBe("+₹5.0 cr");
    expect(inr(null)).toBe("–");
  });

  it("shows signed percents and handles missing values", () => {
    expect(pct(0.0512)).toBe("+5.1%");
    expect(pct(-0.007)).toBe("−0.7%");
    expect(pct(0.0001)).toBe("0.0%");
    expect(pct(null)).toBe("–");
    expect(percentPoints(-0.32, 2, true)).toBe("−0.32");
  });

  it("formats dates and ages", () => {
    expect(day("2024-01-05")).toBe("05 Jan 2024");
    expect(day("2024-01-05", true)).toBe("05 Jan 24");
    const now = new Date("2024-01-10T12:00:00Z");
    expect(ago("2024-01-10T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2024-01-08T12:00:00Z", now)).toBe("2 days ago");
    expect(ago(null, now)).toBe("never");
  });
});
