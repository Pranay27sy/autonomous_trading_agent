import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Leader, type Overview as OverviewData, type SummaryRow, type Trade } from "../api";
import { COLORS, ExcessChart, Sparkbars } from "../components/charts";
import { DataTable, type Column } from "../components/DataTable";
import { Card, ConvictionBadge, Empty, ErrorBox, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, integer, pct } from "../format";

export function Overview() {
  const [f] = useFilters();
  const [minPeople, setMinPeople] = useState(2);
  const [windowDays, setWindowDays] = useState(30);
  const q = useQuery({
    queryKey: ["overview", f, minPeople, windowDays],
    queryFn: () => api.overview(f, minPeople, windowDays),
    placeholderData: keepPreviousData,
  });

  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <OverviewSkeleton />;
  const d = q.data;
  if (d.kpis.trades === 0) {
    return (
      <Empty title="No promoter trades match">
        <p>Widen the filters above, or open the data menu (top right) and refresh if nothing has been downloaded yet.</p>
      </Empty>
    );
  }

  return (
    <div style={{ opacity: q.isPlaceholderData ? 0.6 : 1, transition: "opacity .15s" }}>
      <div className="page-head">
        <h1>Promoter flow</h1>
        <span className="muted">
          {integer(d.kpis.trades)} trades in {integer(d.kpis.stocks)} stocks · {day(d.range.from)} → {day(d.range.to)}
        </span>
      </div>
      <Kpis d={d} />
      <div className="grid two-one">
        <Signal summary={d.summary} horizon={d.signal_horizon} basis={f.basis} />
        <Card
          title="Buying clusters"
          actions={
            <span style={{ display: "flex", gap: 6, alignItems: "center" }} className="muted">
              <select className="select" aria-label="Distinct promoters" value={minPeople} onChange={(e) => setMinPeople(Number(e.target.value))}>
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}+ promoters
                  </option>
                ))}
              </select>
              <select className="select" aria-label="Within days" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
                {[7, 14, 30, 60, 90].map((n) => (
                  <option key={n} value={n}>
                    in {n} days
                  </option>
                ))}
              </select>
            </span>
          }
        >
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
            Several promoters buying the same stock within a short window, often a stronger signal than one buy.
          </p>
          {d.clusters.length === 0 ? (
            <p className="muted">No clusters for these filters.</p>
          ) : (
            <DataTable
              rows={d.clusters}
              rowKey={(r) => r.symbol}
              initialSort={{ key: "end", desc: true }}
              columns={[
                { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
                { key: "promoters", label: "Promoters", align: "right" },
                { key: "total_value", label: "Bought", align: "right", render: (r) => inr(r.total_value) },
                { key: "end", label: "Last buy", align: "right", render: (r) => day(r.end, true) },
              ]}
            />
          )}
        </Card>
      </div>
      {d.top_conviction.length > 0 && <TopConviction rows={d.top_conviction} />}
      <div className="grid halves">
        <Leaders title="Top net buying" rows={d.top_buyers} color={COLORS.buy} />
        <Leaders title="Top net selling" rows={d.top_sellers} color={COLORS.sell} />
      </div>
    </div>
  );
}

function Kpis({ d }: { d: OverviewData }) {
  const k = d.kpis;
  const weeks = d.weekly.length;
  const sparkNote = `Weekly value, last ${weeks} weeks`;
  return (
    <div className="grid kpis">
      <Card>
        <div className="kpi-label">Promoter buying</div>
        <div className="kpi-value">{inr(k.buy_value)}</div>
        <div className="kpi-sub">
          <span className="chip buy">{integer(k.buy_count)} trades</span>
        </div>
        <Sparkbars values={d.weekly.map((w) => w.buy)} color={COLORS.buy} label={sparkNote} />
      </Card>
      <Card>
        <div className="kpi-label">Promoter selling</div>
        <div className="kpi-value">{inr(k.sell_value)}</div>
        <div className="kpi-sub">
          <span className="chip sell">{integer(k.sell_count)} trades</span>
        </div>
        <Sparkbars values={d.weekly.map((w) => w.sell)} color={COLORS.sell} label={sparkNote} />
      </Card>
      <Card>
        <div className="kpi-label">Net flow</div>
        <div className={`kpi-value ${k.net_value >= 0 ? "pos" : "neg"}`}>{inr(k.net_value, true)}</div>
        <div className="kpi-sub">{k.net_value >= 0 ? "net buying" : "net selling"} · buys minus sells</div>
        <Sparkbars values={d.weekly.map((w) => w.net)} color={(v) => (v >= 0 ? COLORS.buy : COLORS.sell)} label={sparkNote} />
      </Card>
      <Card>
        <div className="kpi-label">Stocks</div>
        <div className="kpi-value">{integer(k.stocks)}</div>
        <div className="kpi-sub">{integer(k.stocks_bought)} with promoter buying</div>
      </Card>
    </div>
  );
}

function Signal({ summary, horizon, basis }: { summary: SummaryRow[]; horizon: number; basis: string }) {
  const at = (side: string) => summary.find((r) => r.direction === side && r.horizon_days === horizon && r.events > 0);
  const lines = (["buy", "sell"] as const)
    .map((side) => ({ side, r: at(side) }))
    .filter((x): x is { side: "buy" | "sell"; r: SummaryRow } => !!x.r);
  return (
    <Card title="Does promoter buying beat the market?">
      {lines.length === 0 ? (
        <p className="muted">Not enough price history after these trades yet.</p>
      ) : (
        <>
          {lines.map(({ side, r }) => (
            <p className="headline" key={side}>
              After promoters <b>{side === "buy" ? "bought" : "sold"}</b>, the stock did{" "}
              <b className={(r.mean_excess ?? 0) >= 0 ? "pos" : "neg"}>{pct(r.mean_excess)}</b> vs Nifty over {horizon}{" "}
              trading days on average, and beat it <b>{r.hit_rate != null ? Math.round(r.hit_rate * 100) : "–"}%</b> of
              the time <span className="muted">({integer(r.events)} trades)</span>.
            </p>
          ))}
          <ExcessChart summary={summary} />
          <p className="card-note">
            Entry is the close of the first trading day after the{" "}
            {basis === "disclosure_date" ? "disclosure" : "promoter's trade date (not tradable for you)"}. Excess
            return is the stock's return minus Nifty 50's over the same days.
          </p>
        </>
      )}
    </Card>
  );
}

function Leaders({ title, rows, color }: { title: string; rows: Leader[]; color: string }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.net_value)), 1);
  const columns: Column<Leader>[] = [
    { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
    { key: "company", label: "Company", className: "clip", render: (r) => <span className="muted" title={r.company ?? ""}>{r.company}</span> },
    {
      key: "net_value",
      label: "Net",
      sortValue: (r) => Math.abs(r.net_value),
      render: (r) => (
        <div className="bar-cell">
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(Math.abs(r.net_value) / max) * 100}%`, background: color }} />
          </div>
          <span className="mono" style={{ minWidth: 92, textAlign: "right" }}>
            {inr(Math.abs(r.net_value))}
          </span>
        </div>
      ),
    },
    { key: "buys", label: "Buys", align: "right" },
    { key: "sells", label: "Sells", align: "right" },
  ];
  return (
    <Card title={title}>
      {rows.length === 0 ? <p className="muted">None for these filters.</p> : <DataTable rows={rows} columns={columns} rowKey={(r) => r.symbol} />}
    </Card>
  );
}

function TopConviction({ rows }: { rows: Trade[] }) {
  return (
    <Card
      title="Top conviction buys"
      className="spaced"
      actions={<span className="muted" style={{ fontSize: 12 }}>Higher scores have beaten Nifty more often</span>}
    >
      <ul className="conviction-list">
        {rows.map((t, i) => (
          <li key={`${t.symbol}-${t.event_date}-${i}`}>
            <ConvictionBadge score={t.conviction} reasons={t.conviction_reasons} />
            <StockLink symbol={t.symbol} />
            <span className="mono">{inr(t.value)}</span>
            <span className="muted clip-text" title={t.conviction_reasons.join(" · ")}>
              {t.person} · {t.conviction_reasons.slice(0, 2).join(" · ")}
            </span>
            <span className="faint mono" style={{ marginLeft: "auto" }}>
              {day(t.event_date, true)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <Skeleton height={28} />
      <div className="grid kpis" style={{ marginTop: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={130} />
        ))}
      </div>
      <div className="grid two-one">
        <Skeleton height={380} />
        <Skeleton height={380} />
      </div>
    </>
  );
}
