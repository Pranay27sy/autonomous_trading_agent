import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api, type BacktestRule, type BacktestTrade } from "../api";
import { DataTable } from "../components/DataTable";
import { EquityChart, EventStudyChart } from "../components/researchCharts";
import { Card, ConvictionBadge, Empty, ErrorBox, Segmented, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, integer, pct, signClass } from "../format";

const TABS = ["backtest", "event-study"] as const;
type Tab = (typeof TABS)[number];
const CAPS = ["Large cap", "Mid cap", "Small cap", "Micro cap"];

export function Research() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "event-study" ? "event-study" : "backtest";
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        if (t === "backtest") p.delete("tab");
        else p.set("tab", t);
        return p;
      },
      { replace: true },
    );
  return (
    <>
      <div className="page-head">
        <h1>Research</h1>
        <Segmented
          label="Research tool"
          options={TABS}
          value={tab}
          onChange={setTab}
          format={(t) => (t === "backtest" ? "Backtest lab" : "Event study")}
        />
      </div>
      {tab === "backtest" ? <Backtest /> : <EventStudy />}
      <p className="card-note">
        Entry is the close of the first trading day after the disclosure; returns use dividend- and split-adjusted
        closes, minus Nifty 50 over the same days. No brokerage, taxes, slippage or liquidity limits are modelled, and
        delisted stocks have no prices (survivorship bias). Past results don't guarantee future ones. Research only,
        not investment advice.
      </p>
    </>
  );
}

const DEFAULT_RULE: BacktestRule = {
  side: "buy",
  hold_days: 60,
  min_value: 1e6,
  min_conviction: null,
  min_stake_pct: null,
  sectors: [],
  caps: [],
  start: null,
  end: null,
  one_per_stock_days: 0,
};

function Backtest() {
  const [f] = useFilters();
  const [rule, setRule] = useState<BacktestRule>(DEFAULT_RULE);
  const set = (patch: Partial<BacktestRule>) => setRule({ ...rule, ...patch });
  const sectors = useQuery({ queryKey: ["sectors", { ...f, period: "All" }], queryFn: () => api.sectors({ ...f, period: "All" }) });
  const q = useQuery({
    queryKey: ["backtest", rule, f.marketOnly, f.basis],
    queryFn: () => api.backtest(rule, f),
    placeholderData: keepPreviousData,
  });

  const st = q.data?.stats;
  return (
    <>
      <Card title="Rule" className="spaced">
        <div className="rule-grid">
          <label className="field">
            <span className="filter-label">Trade</span>
            <Segmented
              label="Side"
              options={["buy", "sell"] as const}
              value={rule.side}
              onChange={(side) => set({ side })}
              format={(s) => (s === "buy" ? "Buy after promoter buys" : "Short after promoter sells")}
            />
          </label>
          <label className="field">
            <span className="filter-label">Hold</span>
            <Segmented
              label="Hold days"
              options={[5, 20, 60, 120] as const}
              value={rule.hold_days as 5 | 20 | 60 | 120}
              onChange={(hold_days) => set({ hold_days })}
              format={(d) => `${d}d`}
            />
          </label>
          <label className="field">
            <span className="filter-label">Min value</span>
            <select className="select" value={rule.min_value} onChange={(e) => set({ min_value: Number(e.target.value) })}>
              {[0, 1e6, 1e7, 5e7, 1e8].map((v) => (
                <option key={v} value={v}>
                  {v ? inr(v).replace(".0 ", " ") : "Any"}
                </option>
              ))}
            </select>
          </label>
          {rule.side === "buy" && (
            <label className="field">
              <span className="filter-label">Min conviction</span>
              <select
                className="select"
                value={rule.min_conviction ?? ""}
                onChange={(e) => set({ min_conviction: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">Any</option>
                {[25, 35, 50, 60, 75].map((v) => (
                  <option key={v} value={v}>
                    {v}+
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span className="filter-label">Min stake change</span>
            <select
              className="select"
              value={rule.min_stake_pct ?? ""}
              onChange={(e) => set({ min_stake_pct: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">Any</option>
              {[0.05, 0.1, 0.25, 0.5, 1].map((v) => (
                <option key={v} value={v}>
                  {v}% of company
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="filter-label">One signal per stock per</span>
            <select className="select" value={rule.one_per_stock_days} onChange={(e) => set({ one_per_stock_days: Number(e.target.value) })}>
              {[0, 30, 90, 180].map((v) => (
                <option key={v} value={v}>
                  {v ? `${v} days` : "no limit"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="filter-label">From</span>
            <input className="input" type="date" value={rule.start ?? ""} onChange={(e) => set({ start: e.target.value || null })} />
          </label>
          <label className="field">
            <span className="filter-label">To</span>
            <input className="input" type="date" value={rule.end ?? ""} onChange={(e) => set({ end: e.target.value || null })} />
          </label>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <span className="filter-label">Market cap</span>
          <Chips options={CAPS} selected={rule.caps} onChange={(caps) => set({ caps })} />
        </div>
        {sectors.data && sectors.data.sectors.length > 1 && (
          <div className="field" style={{ marginTop: 12 }}>
            <span className="filter-label">Sectors</span>
            <Chips
              options={sectors.data.sectors.map((s) => s.sector).filter((s) => s !== "Unclassified")}
              selected={rule.sectors}
              onChange={(sectors) => set({ sectors })}
            />
          </div>
        )}
      </Card>

      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data ? (
        <Skeleton height={420} />
      ) : !st || st.trades === 0 ? (
        <Empty title="No trades match this rule">
          <p>Loosen the rule, or wait for more history after recent trades.</p>
        </Empty>
      ) : (
        <div style={{ opacity: q.isFetching ? 0.6 : 1 }}>
          <div className="grid kpis">
            <Stat label="Trades" value={integer(st.trades)} sub={`${integer(st.stocks)} stocks · ${day(st.from)} → ${day(st.to)}`} />
            <Stat
              label="Beat Nifty"
              value={`${Math.round((st.hit_rate ?? 0) * 100)}%`}
              sub={`median ${pct(st.median_excess)} vs Nifty per trade`}
              tone={(st.hit_rate ?? 0) >= 0.5 ? "pos" : "neg"}
            />
            <Stat
              label="Avg vs Nifty per trade"
              value={pct(st.mean_excess)}
              sub={`95% CI ${pct(st.excess_ci95?.[0])} … ${pct(st.excess_ci95?.[1])} · t = ${st.t_stat?.toFixed(1) ?? "–"}`}
              tone={signClass(st.mean_excess)}
            />
            <Stat
              label="Strategy CAGR"
              value={pct(st.strategy_cagr)}
              sub={`Nifty ${pct(st.benchmark_cagr)} · max drawdown ${pct(st.max_drawdown)} (Nifty ${pct(st.benchmark_max_drawdown)})`}
              tone={signClass((st.strategy_cagr ?? 0) - (st.benchmark_cagr ?? 0))}
            />
          </div>
          <Card
            title={<span className="legend"><span style={{ color: "var(--accent)" }}>━ strategy</span><span>━ Nifty 50</span><span>growth of ₹1; equal weight across open trades; flat when none ({Math.round((st.time_invested ?? 0) * 100)}% of days invested)</span></span>}
            className="spaced"
          >
            <EquityChart points={q.data.equity} />
          </Card>
          <Card title={`Trades${st.trades > q.data.trades.length ? ` (latest ${q.data.trades.length})` : ""}`}>
            <DataTable<BacktestTrade>
              rows={q.data.trades}
              rowKey={(t, i) => `${t.symbol}-${t.event_date}-${i}`}
              pageSize={50}
              initialSort={{ key: "event_date", desc: true }}
              columns={[
                { key: "event_date", label: "Disclosed", render: (t) => day(t.event_date) },
                { key: "symbol", label: "Symbol", render: (t) => <StockLink symbol={t.symbol} /> },
                { key: "person", label: "Promoter", className: "clip", render: (t) => <span title={t.person ?? ""}>{t.person}</span> },
                { key: "value", label: "Value", align: "right", render: (t) => inr(t.value) },
                ...(rule.side === "buy"
                  ? [{ key: "conviction", label: "Conviction", render: (t: BacktestTrade) => <ConvictionBadge score={t.conviction} /> }]
                  : []),
                { key: "entry", label: "Entry", render: (t) => day(t.entry, true) },
                { key: "exit", label: "Exit", render: (t) => day(t.exit, true) },
                { key: "return", label: "Return", align: "right", render: (t) => <span className={signClass(t.return)}>{pct(t.return)}</span> },
                { key: "benchmark", label: "Nifty", align: "right", render: (t) => pct(t.benchmark) },
                { key: "excess", label: "vs Nifty", align: "right", render: (t) => <span className={signClass(t.excess)}>{pct(t.excess)}</span> },
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}

function EventStudy() {
  const [f] = useFilters();
  const [groups, setGroups] = useState<"side" | "conviction">("side");
  const q = useQuery({
    queryKey: ["event-study", groups, f.marketOnly, f.basis],
    queryFn: () => api.eventStudy(groups, f),
    placeholderData: keepPreviousData,
  });
  const marks = [-20, 0, 20, 60, 120];
  return (
    <Card
      title="Average return vs Nifty around promoter trades"
      actions={
        <Segmented
          label="Compare"
          options={["side", "conviction"] as const}
          value={groups}
          onChange={setGroups}
          format={(g) => (g === "side" ? "Buys vs sells" : "Buys by conviction")}
        />
      }
    >
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        Each line averages every trade's cumulative return minus Nifty, lined up so day 0 is the entry (the first trading
        day after the disclosure). Shaded bands are 95% confidence intervals. Days before 0 show what the price did
        ahead of the trade.
      </p>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data ? (
        <Skeleton height={320} />
      ) : q.data.groups.length === 0 ? (
        <Empty title="Not enough history yet" />
      ) : (
        <div style={{ opacity: q.isFetching ? 0.6 : 1 }}>
          <EventStudyChart groups={q.data.groups} before={q.data.before} after={q.data.after} />
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col" className="num">
                    Trades
                  </th>
                  {marks.map((d) => (
                    <th key={d} scope="col" className="num">
                      Day {d > 0 ? `+${d}` : d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.groups.map((g) => (
                  <tr key={g.group}>
                    <td>{g.group}</td>
                    <td className="num">{integer(g.events)}</td>
                    {marks.map((d) => {
                      const p = g.points.find((x) => x.day === d);
                      return (
                        <td key={d} className={`num ${signClass(p?.mean)}`}>
                          {pct(p?.mean)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function Stat(props: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card>
      <div className="kpi-label">{props.label}</div>
      <div className={`kpi-value ${props.tone ?? ""}`}>{props.value}</div>
      {props.sub && <div className="kpi-sub">{props.sub}</div>}
    </Card>
  );
}

export function Chips({ options, selected, onChange }: { options: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            className={`chip-toggle ${on ? "on" : ""}`}
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((s) => s !== o) : [...selected, o])}
          >
            {o}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button type="button" className="btn-link faint" onClick={() => onChange([])}>
          clear
        </button>
      )}
    </div>
  );
}
