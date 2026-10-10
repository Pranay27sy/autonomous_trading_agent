// Typed client for the FastAPI backend (promoter_tracker/api.py).
import type { Filters } from "./filters";
import { filtersToParams } from "./filters";

export type Side = "buy" | "sell";

/** Returns are fractions (0.05 = +5%); null when not known yet. */
export interface Trade {
  event_date: string;
  symbol: string;
  company: string | null;
  person: string | null;
  category: string | null;
  direction: Side;
  mode: string | null;
  quantity: number | null;
  value: number | null;
  holding_before_pct: number | null;
  holding_after_pct: number | null;
  holding_change_pct: number | null;
  disclosure_date: string | null;
  trade_to: string | null;
  ret_1: number | null;
  ret_5: number | null;
  ret_20: number | null;
  ret_60: number | null;
  ret_120: number | null;
  exc_1: number | null;
  exc_5: number | null;
  exc_20: number | null;
  exc_60: number | null;
  exc_120: number | null;
}

export interface SummaryRow {
  direction: Side;
  horizon_days: number;
  events: number;
  mean_return: number | null;
  median_return: number | null;
  mean_excess: number | null;
  hit_rate: number | null;
}

export interface Cluster {
  symbol: string;
  company: string | null;
  start: string;
  end: string;
  promoters: number;
  total_value: number;
}

export interface Leader {
  symbol: string;
  company: string | null;
  net_value: number;
  buys: number;
  sells: number;
}

export interface Week {
  week: string;
  buy: number;
  sell: number;
  net: number;
}

export interface Overview {
  range: { from: string | null; to: string | null };
  kpis: {
    trades: number;
    stocks: number;
    stocks_bought: number;
    buy_value: number;
    buy_count: number;
    sell_value: number;
    sell_count: number;
    net_value: number;
  };
  weekly: Week[];
  signal_horizon: number;
  summary: SummaryRow[];
  clusters: Cluster[];
  top_buyers: Leader[];
  top_sellers: Leader[];
}

export interface StockListItem {
  symbol: string;
  company: string | null;
  trades: number;
}

/** A daily bar. open/high/low/volume are null for bars cached before candles were stored. */
export interface Bar {
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface StockDetail {
  symbol: string;
  company: string | null;
  kpis: {
    last_close: number | null;
    last_date: string | null;
    change_1y: number | null;
    net_value: number;
    buys: number;
    sells: number;
    last_holding_pct: number | null;
    after_buys_exc_60: number | null;
    after_buys_hit_60: number | null;
    after_buys_n: number;
  };
  prices: Bar[];
  trades: Trade[];
}

export interface RefreshStatus {
  state: "idle" | "running" | "done" | "error" | "busy";
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  log: string[];
  result: { new_trades: number; price_rows: number; errors: string[]; warnings: string[] } | null;
}

export interface Status {
  last_refresh: string | null;
  /** Newer than last_refresh when the latest attempt failed (or is running). */
  last_attempt: string | null;
  /** The last successful refresh is older than the server's stale threshold. */
  stale: boolean;
  /** Filings whose download failed; retried on the next refresh. */
  failed_filings: number;
  /** Latest disclosure date and latest Nifty close in the cache (YYYY-MM-DD). */
  disclosures_through: string | null;
  prices_through: string | null;
  refresh: RefreshStatus;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" }, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 409) {
    const detail = body?.detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : `Request failed (${res.status})`);
  }
  return body as T;
}

const withFilters = (path: string, f: Filters, extra: Record<string, string> = {}) => {
  const params = filtersToParams(f, true);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `${path}?${params}`;
};

export const api = {
  status: () => request<Status>("/api/status"),
  refresh: (backfillDays = 365) =>
    request<RefreshStatus>(`/api/refresh?backfill_days=${backfillDays}`, { method: "POST" }),
  overview: (f: Filters, minPeople: number, windowDays: number) =>
    request<Overview>(
      withFilters("/api/overview", f, { min_people: String(minPeople), window_days: String(windowDays) }),
    ),
  trades: (f: Filters) => request<{ total: number; rows: Trade[] }>(withFilters("/api/trades", f)),
  stocks: (f: Filters) => request<StockListItem[]>(withFilters("/api/stocks", f)),
  stock: (symbol: string, f: Filters) =>
    request<StockDetail>(withFilters(`/api/stocks/${encodeURIComponent(symbol)}`, f)),
};
