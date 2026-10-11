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
  pledges: PledgeEvent[];
  patterns: PatternRow[];
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

export type AlertKind = "watchlist" | "conviction" | "big_buy" | "big_sell" | "cluster" | "pledge" | "screen" | "pattern";

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
  pledge_invocations: boolean;
  pattern_watchlist: boolean;
  pattern_promoter: boolean;
  pattern_min_quality: number;
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

interface TrackRecord {
  exc_20: number | null;
  hit_20: number | null;
  n_20: number;
  exc_60: number | null;
  hit_60: number | null;
  n_60: number;
  exc_120: number | null;
  hit_120: number | null;
  n_120: number;
}

export interface PersonRow extends TrackRecord {
  slug: string;
  name: string;
  companies: number;
  top_company: string | null;
  trades: number;
  buys: number;
  sells: number;
  buy_value: number;
  net_value: number;
  last_trade: string | null;
}

export interface PersonProfile {
  slug: string;
  name: string;
  aliases: string[];
  category: string | null;
  trades: number;
  buy_value: number;
  sell_value: number;
  track: TrackRecord;
  companies: {
    symbol: string;
    company: string | null;
    trades: number;
    net_value: number;
    first: string;
    last: string;
    holding_after_pct: number | null;
  }[];
  trades_list: Trade[];
}

export interface PledgeEvent {
  symbol: string;
  company: string | null;
  person: string | null;
  kind: "created" | "released" | "invoked";
  quantity: number | null;
  /** quantity × that day's close (the filed value is unreliable) */
  value: number | null;
  event_date: string;
  trade_key: string;
}

export interface PledgeCompany {
  symbol: string;
  company: string | null;
  events: number;
  promoters: number;
  created_shares: number;
  released_shares: number;
  invoked_shares: number;
  created_value: number;
  released_value: number;
  invoked_value: number;
  net_shares: number;
  net_pct: number | null;
  invocations: number;
  last_event: string;
  last_kind: PledgeEvent["kind"];
  risk: "high" | "rising" | "flat" | "easing";
}

export interface PledgeSummary {
  totals: Record<PledgeEvent["kind"], { events: number; value: number; companies: number }>;
  companies: PledgeCompany[];
  events: PledgeEvent[];
}

export interface MarketFlow {
  weekly: {
    week: string;
    buy_value: number;
    sell_value: number;
    net_value: number;
    trades: number;
    stocks_net_buying: number;
    stocks_net_selling: number;
    nifty: number | null;
  }[];
  daily: { day: string; net_value: number; trades: number }[];
  timing: { group: string; weeks: number; avg_net_value: number; nifty_next: number; nifty_up_share: number }[];
  timing_weeks: number;
  totals: { weeks: number; net_buying_weeks: number; avg_breadth: number; avg_sellers: number } | null;
}

export interface CompareStock {
  symbol: string;
  company: string | null;
  sector: string | null;
  path: { time: string; value: number }[];
  trades: { time: string; direction: Side; value: number | null; person: string | null; conviction: number | null }[];
  stats: {
    return: number;
    volatility: number | null;
    max_drawdown: number;
    net_value: number;
    buys: number;
    sells: number;
    max_conviction: number | null;
  } | null;
}

export interface ScreenCriteria {
  lookback_days: number;
  min_net_value: number | null;
  min_buys: number | null;
  min_promoters: number | null;
  min_conviction: number | null;
  /** 0.2 = at least 20% below the 52-week high */
  min_below_high: number | null;
  max_change_3m: number | null;
  sectors: string[];
  caps: string[];
  exclude_pledge_risk: boolean;
  sort: "net_value" | "conviction" | "below_high" | "promoters" | "change_3m";
}

export interface ScreenRow {
  symbol: string;
  company: string | null;
  sector: string | null;
  cap_bucket: string | null;
  net_value: number;
  buys: number;
  sells: number;
  promoters: number;
  conviction: number | null;
  last_trade: string;
  last_direction: Side;
  last_close: number | null;
  change_1m: number | null;
  change_3m: number | null;
  below_high: number | null;
  pledge_risk: "high" | "rising" | "flat" | "easing" | null;
  watching: boolean;
}

export interface SavedScreen {
  id: number;
  name: string;
  criteria: Partial<ScreenCriteria>;
  alert: boolean;
  last_matches: string[] | null;
  created_at: string;
}

export type PatternKey =
  | "head_shoulders"
  | "inverse_head_shoulders"
  | "double_top"
  | "double_bottom"
  | "cup_handle"
  | "ascending_triangle"
  | "descending_triangle";

export interface PatternRow {
  symbol: string;
  pattern: PatternKey;
  name: string;
  direction: "bull" | "bear";
  start: string;
  /** null while the pattern is still forming */
  breakout: string | null;
  breakout_price: number | null;
  /** neckline / rim / flat side at the breakout (or today, while forming) */
  level: number;
  /** textbook measured-move target */
  target: number;
  /** price beyond which the pattern has failed */
  invalidation: number;
  /** 0–100: how textbook the formation is (not a prediction) */
  quality: number;
  quality_reasons: string[];
  status: "forming" | "active" | "target_hit" | "failed" | "expired";
  resolved: string | null;
  trend_move: number | null;
  bars: number;
  /** forming only: last close vs the level */
  distance: number | null;
  volume_ratio: number | null;
  points: { time: string; price: number; label: string }[];
  line: { time: string; price: number }[];
  promoter_buys: number;
  promoter_net_value: number;
  promoter_buying: boolean;
  /** excess vs Nifty in the pattern's direction: positive = it worked */
  signed_5: number | null;
  signed_20: number | null;
  signed_60: number | null;
  company?: string | null;
  last_close?: number | null;
  since_breakout?: number | null;
}

export interface PatternPerf {
  n: number;
  mean_20: number | null;
  mean_60: number | null;
  median_60: number | null;
  worked_60: number | null;
  /** of resolved patterns, the share that reached the target before failing */
  target_hit: number | null;
}

export interface PatternStats {
  patterns: {
    pattern: PatternKey;
    name: string;
    direction: "bull" | "bear";
    count: number;
    all: PatternPerf;
    promoter: PatternPerf;
    no_promoter: PatternPerf;
    tiers: Record<"High" | "Medium" | "Low", PatternPerf>;
  }[];
  total: number;
  forming: number;
  from: string | null;
  to: string | null;
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
  market: (f: Filters) => request<MarketFlow>(withFilters("/api/market", f)),
  recentPatterns: (days: number, direction: string, pattern: string, promoterOnly: boolean, minQuality: number, forming = false) =>
    request<{ rows: PatternRow[]; through: string | null }>(
      `/api/patterns/recent?days=${days}&direction=${direction}&pattern=${pattern}&promoter_only=${promoterOnly}&min_quality=${minQuality}&forming=${forming}`,
    ),
  patternStats: (minQuality = 0) => request<PatternStats>(`/api/patterns/stats?min_quality=${minQuality}`),
  patternStudy: (pattern: string, split: "pattern" | "promoter" | "quality") =>
    request<EventStudy>(`/api/patterns/study?pattern=${pattern}&split=${split}`),
  screenPresets: () => request<Record<string, Partial<ScreenCriteria>>>("/api/screener/presets"),
  runScreen: (c: ScreenCriteria, f: Filters) =>
    request<{ rows: ScreenRow[]; count: number }>(`/api/screener/run?market_only=${f.marketOnly}&basis=${f.basis}`, {
      method: "POST",
      json: c,
    }),
  screens: () => request<SavedScreen[]>("/api/screens"),
  saveScreen: (name: string, criteria: ScreenCriteria, alert: boolean) =>
    request<{ id: number; name: string; matches: number }>("/api/screens", { method: "POST", json: { name, criteria, alert } }),
  deleteScreen: (id: number) => request<{ deleted: number }>(`/api/screens/${id}`, { method: "DELETE" }),
  compare: (symbols: string[], days: number | null, f: Filters) =>
    request<{ start: string; end: string; stocks: CompareStock[] }>(
      withFilters("/api/compare", { ...f, period: "All" }, { symbols: symbols.join(","), ...(days ? { days: String(days) } : {}) }),
    ),
  pledges: (period: string) => request<PledgeSummary>(`/api/pledges?period=${encodeURIComponent(period)}`),
  people: (f: Filters) => request<PersonRow[]>(withFilters("/api/people", f)),
  person: (slug: string, f: Filters) =>
    request<PersonProfile>(withFilters(`/api/people/${encodeURIComponent(slug)}`, f)),
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
