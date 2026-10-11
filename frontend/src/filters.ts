// Filter-bar state lives in the URL (?period=3M&sides=buy...) so views are shareable
// and survive reloads. Defaults are left out of the URL to keep it short.
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { Side } from "./api";

export const PERIODS = ["1M", "3M", "6M", "1Y", "3Y", "All"] as const;
export type Period = (typeof PERIODS)[number];
export const MIN_VALUES = [0, 1e6, 1e7, 1e8] as const; // ₹ any, 10 L, 1 cr, 10 cr
export type Basis = "disclosure_date" | "trade_to";

export interface Filters {
  period: Period;
  sides: Side[];
  minValue: number;
  marketOnly: boolean;
  basis: Basis;
  /** Show promoter-group members trading with each other (hidden by default). */
  includeTransfers: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  period: "1Y",
  sides: ["buy", "sell"],
  minValue: 1e6,
  marketOnly: true,
  basis: "disclosure_date",
  includeTransfers: false,
};

export function parseFilters(params: URLSearchParams): Filters {
  const period = params.get("period");
  const sides = params.get("sides");
  const min = Number(params.get("min"));
  return {
    period: (PERIODS as readonly string[]).includes(period ?? "") ? (period as Period) : DEFAULT_FILTERS.period,
    sides:
      sides === null
        ? DEFAULT_FILTERS.sides
        : (["buy", "sell"] as Side[]).filter((s) => sides.split(",").includes(s)),
    minValue: params.has("min") && Number.isFinite(min) && min >= 0 ? min : DEFAULT_FILTERS.minValue,
    marketOnly: params.get("market") !== "all",
    basis: params.get("basis") === "trade" ? "trade_to" : "disclosure_date",
    includeTransfers: params.get("transfers") === "show",
  };
}

/** URL params for the filters: short app URLs, or the API's parameter names. */
export function filtersToParams(f: Filters, forApi = false): URLSearchParams {
  const p = new URLSearchParams();
  if (forApi) {
    p.set("period", f.period);
    p.set("sides", f.sides.join(","));
    p.set("min_value", String(f.minValue));
    p.set("market_only", String(f.marketOnly));
    p.set("basis", f.basis);
    p.set("include_transfers", String(f.includeTransfers));
    return p;
  }
  const d = DEFAULT_FILTERS;
  if (f.period !== d.period) p.set("period", f.period);
  if (f.sides.join(",") !== d.sides.join(",")) p.set("sides", f.sides.join(","));
  if (f.minValue !== d.minValue) p.set("min", String(f.minValue));
  if (!f.marketOnly) p.set("market", "all");
  if (f.basis !== d.basis) p.set("basis", "trade");
  if (f.includeTransfers) p.set("transfers", "show");
  return p;
}

export function useFilters(): [Filters, (patch: Partial<Filters>) => void] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const update = useCallback(
    (patch: Partial<Filters>) => {
      setParams((prev) => filtersToParams({ ...parseFilters(prev), ...patch }), { replace: true });
    },
    [setParams],
  );
  return [filters, update];
}
