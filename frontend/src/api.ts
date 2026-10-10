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
  /** One promoter-group member selling to another (see analysis.internal_transfers). */
  internal_transfer: boolean;
  sector: string | null;
  cap_bucket: string | null;
  /** 0–100 for buys (see conviction.py); null for sells and transfers. */
  conviction: number | null;
  conviction_reasons: string[];
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
  top_conviction: Trade[];
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
  sector: string | null;
  industry: string | null;
  market_cap: number | null;
  cap_bucket: string | null;
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
  unread_alerts: number;
  refresh: RefreshStatus;
}

export interface WatchItem {
  symbol: string;
  company: string | null;
  added_at: string;
  last_trade: { event_date: string; direction: Side; value: number | null; person: string | null } | null;
  net_value_90d: number;
  trades_90d: number;
  last_close: number | null;
  change_1m: number | null;
}

export type AlertKind = "watchlist" | "conviction" | "big_buy" | "big_sell" | "cluster";

export interface Alert {
  id: number;
  created_at: string;
  kind: AlertKind;
  symbol: string;
  company: string | null;
  direction: Side | null;
  value: number | null;
  event_date: string | null;
  title: string;
  detail: string | null;
  read: boolean;
  notified_at: string | null;
}

/** Alert rules; a null threshold turns that rule off. */
export interface AlertRules {
  watchlist_trades: boolean;
  big_buy_value: number | null;
  big_sell_value: number | null;
  cluster_min_people: number | null;
  cluster_window_days: number;
  market_only: boolean;
  min_conviction: number | null;
}

export interface AlertSettings {
  rules: AlertRules;
  /** Which delivery channels the server has configured (secrets stay on the server). */
  channels: { telegram: boolean; email: boolean };
}

export interface BacktestRule {
  side: Side;
  hold_days: number;
  min_value: number;
  min_conviction: number | null;
  min_stake_pct: number | null;
  sectors: string[];
  caps: string[];
  start: string | null;
  end: string | null;
  one_per_stock_days: number;
}

export interface BacktestTrade {
  symbol: string;
  company: string | null;
  person: string | null;
  event_date: string;
  entry: string;
  exit: string;
  value: number | null;
  conviction: number | null;
  return: number | null;
  benchmark: number | null;
  excess: number | null;
}

export interface BacktestResult {
  stats: {
    trades: number;
    stocks?: number;
    hit_rate?: number;
    mean_return?: number;
    median_return?: number;
    mean_excess?: number | null;
    median_excess?: number | null;
    excess_ci95?: [number | null, number | null];
    t_stat?: number | null;
    best?: number;
    worst?: number;
    strategy_total?: number;
    benchmark_total?: number;
    strategy_cagr?: number;
    benchmark_cagr?: number;
    max_drawdown?: number;
    benchmark_max_drawdown?: number;
    time_invested?: number;
    from?: string;
    to?: string;
  };
  equity: { time: string; strategy: number; benchmark: number }[];
  trades: BacktestTrade[];
}

export interface EventStudy {
  before: number;
  after: number;
  groups: {
    group: string;
    events: number;
    points: { day: number; mean: number | null; lo: number | null; hi: number | null; n: number }[];
  }[];
}

export interface FlowRow {
  buy_value: number;
  sell_value: number;
  net_value: number;
  trades: number;
  stocks: number;
  stocks_net_buying: number;
  top_buy: string | null;
}

export interface Sectors {
  sectors: (FlowRow & { sector: string })[];
  caps: (FlowRow & { bucket: string })[];
  classified_share: number | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
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
  watchlist: (f: Filters) => request<WatchItem[]>(withFilters("/api/watchlist", f)),
  watch: (symbol: string) =>
    request<{ symbol: string; watching: boolean }>(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: "PUT" }),
  unwatch: (symbol: string) =>
    request<{ symbol: string; watching: boolean }>(`/api/watchlist/${encodeURIComponent(symbol)}`, {
      method: "DELETE",
    }),
  sectors: (f: Filters) => request<Sectors>(withFilters("/api/sectors", f)),
  backtest: (r: BacktestRule, f: Filters) => {
    const p = new URLSearchParams({
      side: r.side,
      hold_days: String(r.hold_days),
      min_value: String(r.min_value),
      one_per_stock_days: String(r.one_per_stock_days),
      market_only: String(f.marketOnly),
      basis: f.basis,
    });
    if (r.min_conviction != null && r.side === "buy") p.set("min_conviction", String(r.min_conviction));
    if (r.min_stake_pct != null) p.set("min_stake_pct", String(r.min_stake_pct));
    if (r.sectors.length) p.set("sectors", r.sectors.join(","));
    if (r.caps.length) p.set("caps", r.caps.join(","));
    if (r.start) p.set("start", r.start);
    if (r.end) p.set("end", r.end);
    return request<BacktestResult>(`/api/research/backtest?${p}`);
  },
  eventStudy: (groups: "side" | "conviction", f: Filters) =>
    request<EventStudy>(`/api/research/event-study?groups=${groups}&market_only=${f.marketOnly}&basis=${f.basis}`),
  alerts: (limit = 100) => request<{ unread: number; alerts: Alert[] }>(`/api/alerts?limit=${limit}`),
  markRead: (ids?: number[]) =>
    request<{ unread: number }>("/api/alerts/read", { method: "POST", json: ids ? { ids } : {} }),
  alertSettings: () => request<AlertSettings>("/api/alerts/settings"),
  saveAlertSettings: (rules: AlertRules) =>
    request<AlertSettings>("/api/alerts/settings", { method: "PUT", json: rules }),
  testAlert: () => request<{ sent: string[]; errors: string[] }>("/api/alerts/test", { method: "POST" }),
};
