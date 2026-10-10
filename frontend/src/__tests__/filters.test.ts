import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filtersToParams, parseFilters } from "../filters";

describe("filters", () => {
  it("leaves defaults out of the URL and round-trips the rest", () => {
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe("");
    const f = { ...DEFAULT_FILTERS, period: "3M" as const, sides: ["sell" as const], minValue: 0, marketOnly: false };
    const params = filtersToParams(f);
    expect(params.toString()).toBe("period=3M&sides=sell&min=0&market=all");
    expect(parseFilters(params)).toEqual(f);
  });

  it("ignores junk in the URL", () => {
    const f = parseFilters(new URLSearchParams("period=2W&sides=hold,buy&min=-5&basis=x"));
    expect(f).toEqual({ ...DEFAULT_FILTERS, sides: ["buy"] });
  });

  it("uses the API's parameter names for requests", () => {
    expect(filtersToParams(DEFAULT_FILTERS, true).toString()).toBe(
      "period=1Y&sides=buy%2Csell&min_value=1000000&market_only=true&basis=disclosure_date",
    );
  });
});
