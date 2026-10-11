import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ColorType, createChart, HistogramSeries, LineSeries, type Time } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MarketFlow, type Sectors } from "../api";
import { COLORS } from "../components/charts";
import { DataTable } from "../components/DataTable";
import { Card, Empty, ErrorBox, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, integer, pct, signClass } from "../format";

export function Market() {
  const [f] = useFilters();
  const flow = useQuery({ queryKey: ["market", f], queryFn: () => api.market(f), placeholderData: keepPreviousData });
  const sectors = useQuery({ queryKey: ["sectors", f], queryFn: () => api.sectors(f), placeholderData: keepPreviousData });

  if (flow.error) return <ErrorBox error={flow.error} />;
  const m = flow.data;
  return (
    <>
      <div className="page-head">
        <h1>Market</h1>
        <span className="muted">Promoter buying and selling across all stocks, week by week, against Nifty 50.</span>
      </div>
      {!m ? (
        <Skeleton height={480} />
      ) : !m.totals ? (
        <Empty title="No promoter trades in this period" />
      ) : (
        <div style={{ opacity: flow.isPlaceholderData ? 0.6 : 1 }}>
          <div className="grid kpis">
            <Card>
              <div className="kpi-label">Weeks of net promoter buying</div>
              <div className="kpi-value">
                {integer(m.totals.net_buying_weeks)} <span className="muted" style={{ fontSize: 16 }}>of {integer(m.totals.weeks)}</span>
              </div>
              <div className="kpi-sub">by rupee value; big sellers dominate most weeks</div>
            </Card>
            <Card>
              <div className="kpi-label">Breadth per week</div>
              <div className="kpi-value">
                <span className="pos">{m.totals.avg_breadth.toFixed(0)}</span>
                <span className="muted"> / </span>
                <span className="neg">{m.totals.avg_sellers.toFixed(0)}</span>
              </div>
              <div className="kpi-sub">stocks with net promoter buying / selling, on average</div>
            </Card>
            {m.timing.length === 3 && (
              <Card>
                <div className="kpi-label">Nifty after heavy promoter buying</div>
                <div className={`kpi-value ${signClass(m.timing[2]!.nifty_next)}`}>{pct(m.timing[2]!.nifty_next)}</div>
                <div className="kpi-sub">
                  avg over the next {m.timing_weeks} weeks, vs {pct(m.timing[0]!.nifty_next)} after heavy selling
                </div>
              </Card>
            )}
          </div>
          <Card
            title={<span className="legend"><span className="pos">▮ net buying</span><span className="neg">▮ net selling</span><span>━ Nifty 50 (right)</span><span>weekly</span></span>}
            className="spaced"
          >
            <FlowChart weekly={m.weekly} />
          </Card>
          <div className="grid two-one">
            <Card title="Breadth: stocks with net promoter buying vs selling">
              <BreadthChart weekly={m.weekly} />
            </Card>
            <Card title={`Nifty over the next ${m.timing_weeks} weeks`}>
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
                Weeks split into thirds by net promoter buying. A rough gauge with overlapping windows, not a forecast.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Weeks with…</th>
                      <th scope="col" className="num">Weeks</th>
                      <th scope="col" className="num">Nifty next</th>
                      <th scope="col" className="num">Up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...m.timing].reverse().map((t) => (
                      <tr key={t.group}>
                        <td>{t.group}</td>
                        <td className="num">{t.weeks}</td>
                        <td className={`num ${signClass(t.nifty_next)}`}>{pct(t.nifty_next)}</td>
                        <td className="num">{Math.round(t.nifty_up_share * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
          <Card title="Daily net promoter flow" className="spaced">
            <Calendar daily={m.daily} />
          </Card>
        </div>
      )}
      {sectors.data && <SectorsView data={sectors.data} />}
    </>
  );
}

function useChart(build: (el: HTMLDivElement) => () => void, deps: unknown[]) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    return build(box.current);
  }, deps); // build closes over the same values as deps
  return box;
}

const chartOptions = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: "transparent" },
    textColor: COLORS.muted,
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: 11,
    attributionLogo: false,
  },
  grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
  timeScale: { borderColor: COLORS.grid },
} as const;

function FlowChart({ weekly }: { weekly: MarketFlow["weekly"] }) {
  const box = useChart(
    (el) => {
      const chart = createChart(el, {
        ...chartOptions,
        leftPriceScale: { visible: true, borderColor: COLORS.grid },
        rightPriceScale: { visible: true, borderColor: COLORS.grid },
        localization: { priceFormatter: (p: number) => (Math.abs(p) > 1e5 ? inr(p) : p.toFixed(0)) },
      });
      const net = chart.addSeries(HistogramSeries, { priceScaleId: "left", priceLineVisible: false, lastValueVisible: false });
      net.setData(
        weekly.map((w) => ({
          time: w.week as Time,
          value: w.net_value,
          color: w.net_value >= 0 ? COLORS.buy : COLORS.sell,
        })),
      );
      const nifty = chart.addSeries(LineSeries, { priceScaleId: "right", color: COLORS.price, lineWidth: 2, priceLineVisible: false });
      nifty.setData(weekly.filter((w) => w.nifty != null).map((w) => ({ time: w.week as Time, value: w.nifty! })));
      chart.timeScale().fitContent();
      return () => chart.remove();
    },
    [weekly],
  );
  return <div className="chart-box" style={{ height: 320 }} ref={box} role="img" aria-label="Weekly net promoter flow and Nifty" />;
}

function BreadthChart({ weekly }: { weekly: MarketFlow["weekly"] }) {
  const box = useChart(
    (el) => {
      const chart = createChart(el, {
        ...chartOptions,
        rightPriceScale: { borderColor: COLORS.grid },
        localization: { priceFormatter: (p: number) => Math.abs(p).toFixed(0) }, // counts of stocks
      });
      const buyers = chart.addSeries(HistogramSeries, { color: COLORS.buy, priceLineVisible: false, lastValueVisible: false });
      const sellers = chart.addSeries(HistogramSeries, { color: COLORS.sell, priceLineVisible: false, lastValueVisible: false });
      buyers.setData(weekly.map((w) => ({ time: w.week as Time, value: w.stocks_net_buying })));
      sellers.setData(weekly.map((w) => ({ time: w.week as Time, value: -w.stocks_net_selling })));
      chart.timeScale().fitContent();
      return () => chart.remove();
    },
    [weekly],
  );
  return <div className="chart-box" style={{ height: 240 }} ref={box} role="img" aria-label="Weekly breadth of promoter buying" />;
}

/** GitHub-style calendar: one cell per day, colour by net flow (log scale). */
function Calendar({ daily }: { daily: MarketFlow["daily"] }) {
  const [tip, setTip] = useState<{ x: number; y: number; d: MarketFlow["daily"][number] } | null>(null);
  const { cells, weeks, months, max } = useMemo(() => {
    const byDay = new Map(daily.map((d) => [d.day, d]));
    if (!daily.length) return { cells: [], weeks: 0, months: [] as { x: number; label: string }[], max: 1 };
    const first = new Date(`${daily[0]!.day}T00:00:00Z`);
    const last = new Date(`${daily[daily.length - 1]!.day}T00:00:00Z`);
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7)); // back to Monday
    const out: { col: number; row: number; iso: string; d?: MarketFlow["daily"][number] }[] = [];
    const ms: { x: number; label: string }[] = [];
    let col = 0;
    let lastMonth = -1;
    for (const t = new Date(first); t <= last; t.setUTCDate(t.getUTCDate() + 1)) {
      const row = (t.getUTCDay() + 6) % 7;
      if (row === 0 && out.length) col++;
      if (row > 4) continue; // weekdays only
      const iso = t.toISOString().slice(0, 10);
      if (t.getUTCMonth() !== lastMonth && row === 0) {
        ms.push({ x: col, label: t.toLocaleString("en-IN", { month: "short", timeZone: "UTC" }) });
        lastMonth = t.getUTCMonth();
      }
      out.push({ col, row, iso, d: byDay.get(iso) });
    }
    const mx = Math.max(...daily.map((d) => Math.abs(d.net_value)), 1);
    return { cells: out, weeks: col + 1, months: ms, max: mx };
  }, [daily]);

  const size = 12;
  const gap = 3;
  const W = 28 + weeks * (size + gap);
  const H = 18 + 5 * (size + gap);
  const shade = (v: number) => {
    if (!v) return "#161b24";
    const a = 0.25 + 0.75 * (Math.log10(1 + Math.abs(v) / 1e5) / Math.log10(1 + max / 1e5));
    return v > 0 ? `rgba(38,166,154,${a.toFixed(2)})` : `rgba(239,83,80,${a.toFixed(2)})`;
  };
  return (
    <div style={{ position: "relative", overflowX: "auto" }}>
      <svg width={W} height={H} role="img" aria-label="Calendar of daily promoter flow" onMouseLeave={() => setTip(null)}>
        {months.map((m, i) => (
          <text key={i} x={28 + m.x * (size + gap)} y={10} fill={COLORS.muted} fontSize={10} fontFamily="IBM Plex Mono">
            {m.label}
          </text>
        ))}
        {["M", "T", "W", "T", "F"].map((l, i) => (
          <text key={i} x={8} y={18 + i * (size + gap) + 10} fill={COLORS.faint} fontSize={10} fontFamily="IBM Plex Mono">
            {l}
          </text>
        ))}
        {cells.map((c) => (
          <rect
            key={c.iso}
            x={28 + c.col * (size + gap)}
            y={18 + c.row * (size + gap)}
            width={size}
            height={size}
            rx={2}
            fill={shade(c.d?.net_value ?? 0)}
            onMouseEnter={() => setTip(c.d ? { x: 28 + c.col * (size + gap), y: 18 + c.row * (size + gap), d: c.d } : null)}
          />
        ))}
      </svg>
      {tip && (
        <div className="chart-tip" style={{ left: Math.min(tip.x, W - 220), top: tip.y + 18 }}>
          <div className="mono">{day(tip.d.day)}</div>
          <div className="row">
            <span className={`mono ${signClass(tip.d.net_value)}`}>{inr(tip.d.net_value, true)}</span>
            <span className="muted">{tip.d.trades} trades</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SectorsView({ data }: { data: Sectors }) {
  if (!data.sectors.length) return null;
  const max = Math.max(...data.sectors.map((s) => Math.abs(s.net_value)), 1);
  const lowCoverage = (data.classified_share ?? 0) < 0.5;
  return (
    <div className="grid two-one" style={{ marginTop: 16 }}>
      <Card title="Promoter flow by sector">
        {lowCoverage && (
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
            Only {Math.round((data.classified_share ?? 0) * 100)}% of trades have a sector yet; the next refresh looks up the
            rest.
          </p>
        )}
        <DataTable
          rows={data.sectors}
          rowKey={(s) => s.sector}
          columns={[
            { key: "sector", label: "Sector" },
            {
              key: "net_value",
              label: "Net flow",
              render: (s) => (
                <div className="bar-cell">
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(Math.abs(s.net_value) / max) * 100}%`, background: s.net_value >= 0 ? COLORS.buy : COLORS.sell }}
                    />
                  </div>
                  <span className={`mono ${signClass(s.net_value)}`} style={{ minWidth: 100, textAlign: "right" }}>
                    {inr(s.net_value, true)}
                  </span>
                </div>
              ),
            },
            { key: "stocks_net_buying", label: "Stocks net buying", align: "right", render: (s) => `${s.stocks_net_buying} of ${s.stocks}` },
            { key: "trades", label: "Trades", align: "right" },
            { key: "top_buy", label: "Top buy", render: (s) => (s.top_buy ? <StockLink symbol={s.top_buy} /> : "–") },
          ]}
        />
      </Card>
      <Card title="By market cap">
        <DataTable
          rows={data.caps}
          rowKey={(c) => c.bucket}
          columns={[
            { key: "bucket", label: "Bucket" },
            { key: "buy_value", label: "Bought", align: "right", render: (c) => inr(c.buy_value) },
            { key: "sell_value", label: "Sold", align: "right", render: (c) => inr(c.sell_value) },
            { key: "net_value", label: "Net", align: "right", render: (c) => <span className={signClass(c.net_value)}>{inr(c.net_value, true)}</span> },
            { key: "stocks", label: "Stocks", align: "right" },
          ]}
        />
        <p className="card-note">Large ≥ ₹50,000 cr · Mid ≥ ₹15,000 cr · Small ≥ ₹2,000 cr · Micro below (current market cap).</p>
      </Card>
    </div>
  );
}
