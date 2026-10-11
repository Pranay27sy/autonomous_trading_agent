import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PatternPerf, type PatternRow } from "../api";
import { DataTable } from "../components/DataTable";
import { EventStudyChart } from "../components/researchCharts";
import { Card, Empty, ErrorBox, Segmented, Skeleton, StockLink, Switch } from "../components/ui";
import { day, inr, integer, pct, price, signClass } from "../format";

export function DirectionChip({ direction }: { direction: "bull" | "bear" }) {
  return <span className={`chip ${direction === "bull" ? "buy" : "sell"}`}>{direction === "bull" ? "bullish ↑" : "bearish ↓"}</span>;
}

function Perf({ p }: { p: PatternPerf }) {
  if (!p.n) return <span className="faint">–</span>;
  return (
    <span>
      <span className={`mono ${(p.worked_60 ?? 0) > 0.5 ? "pos" : "neg"}`}>{Math.round((p.worked_60 ?? 0) * 100)}%</span>
      <span className="muted"> · avg {pct(p.mean_60)} · n={integer(p.n)}</span>
    </span>
  );
}

export function Patterns() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [direction, setDirection] = useState<"all" | "bull" | "bear">("all");
  const [pattern, setPattern] = useState("all");
  const [promoterOnly, setPromoterOnly] = useState(false);
  const [studyPattern, setStudyPattern] = useState("all");
  const stats = useQuery({ queryKey: ["pattern-stats"], queryFn: api.patternStats });
  const recent = useQuery({
    queryKey: ["patterns-recent", days, direction, pattern, promoterOnly],
    queryFn: () => api.recentPatterns(days, direction, pattern, promoterOnly),
    placeholderData: keepPreviousData,
  });
  const split = studyPattern === "all" ? "pattern" : "promoter";
  const study = useQuery({
    queryKey: ["pattern-study", studyPattern, split],
    queryFn: () => api.patternStudy(studyPattern, split),
    placeholderData: keepPreviousData,
  });

  if (stats.error) return <ErrorBox error={stats.error} />;
  const s = stats.data;
  return (
    <>
      <div className="page-head">
        <h1>Chart patterns</h1>
        <span className="muted">
          Classic patterns found by fixed rules on daily closes, with how each one actually did on these stocks, and whether
          promoter buying during the pattern made a difference.
        </span>
      </div>

      <Card title="How each pattern performed after its breakout" className="spaced">
        {!s ? (
          <Skeleton height={260} />
        ) : s.total === 0 ? (
          <Empty title="No patterns yet">The first scan runs in the background after the server starts.</Empty>
        ) : (
          <>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
              "Worked" = the stock moved the pattern's way vs Nifty 50 over the 60 trading days after the breakout (up for
              bullish, down for bearish). {integer(s.total)} patterns, {day(s.from)} → {day(s.to)}.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Pattern</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">Found</th>
                    <th scope="col" className="num">Worked (60d)</th>
                    <th scope="col" className="num">Avg vs Nifty 20d</th>
                    <th scope="col" className="num">Avg 60d</th>
                    <th scope="col" className="num">Median 60d</th>
                    <th scope="col">With promoter buying</th>
                    <th scope="col">Without</th>
                  </tr>
                </thead>
                <tbody>
                  {s.patterns.map((p) => (
                    <tr key={p.pattern}>
                      <td>
                        <button type="button" className="btn-link" onClick={() => setStudyPattern(p.pattern)} title="Show its event study below">
                          {p.name}
                        </button>
                      </td>
                      <td>
                        <DirectionChip direction={p.direction} />
                      </td>
                      <td className="num">{integer(p.count)}</td>
                      <td className={`num ${(p.all.worked_60 ?? 0) > 0.5 ? "pos" : "neg"}`}>
                        {p.all.worked_60 != null ? `${Math.round(p.all.worked_60 * 100)}%` : "–"}
                      </td>
                      <td className={`num ${signClass(p.all.mean_20)}`}>{pct(p.all.mean_20)}</td>
                      <td className={`num ${signClass(p.all.mean_60)}`}>{pct(p.all.mean_60)}</td>
                      <td className={`num ${signClass(p.all.median_60)}`}>{pct(p.all.median_60)}</td>
                      <td>
                        <Perf p={p.promoter} />
                      </td>
                      <td>
                        <Perf p={p.no_promoter} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="card-note">
              Returns are in the pattern's direction, so positive means it worked. A positive average with a negative median
              means it usually failed a little but occasionally won big. No costs or slippage; delisted stocks are missing.
              Research only, not investment advice.
            </p>
          </>
        )}
      </Card>

      <Card
        title="Recent breakouts"
        className="spaced"
        actions={
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Segmented label="Within" options={[7, 30, 90] as const} value={days} onChange={setDays} format={(d) => `${d}d`} />
            <Segmented
              label="Direction"
              options={["all", "bull", "bear"] as const}
              value={direction}
              onChange={setDirection}
              format={(d) => (d === "all" ? "All" : d === "bull" ? "Bullish" : "Bearish")}
            />
            <select className="select" aria-label="Pattern" value={pattern} onChange={(e) => setPattern(e.target.value)}>
              <option value="all">All patterns</option>
              {(s?.patterns ?? []).map((p) => (
                <option key={p.pattern} value={p.pattern}>
                  {p.name}
                </option>
              ))}
            </select>
            <Switch label="Promoters buying during it" checked={promoterOnly} onChange={setPromoterOnly} />
          </span>
        }
      >
        {recent.error ? (
          <ErrorBox error={recent.error} />
        ) : !recent.data ? (
          <Skeleton height={300} />
        ) : recent.data.rows.length === 0 ? (
          <Empty title="No breakouts match" />
        ) : (
          <div style={{ opacity: recent.isPlaceholderData ? 0.6 : 1 }}>
            <DataTable<PatternRow>
              rows={recent.data.rows}
              rowKey={(r) => `${r.symbol}-${r.pattern}-${r.breakout}`}
              pageSize={25}
              columns={[
                { key: "breakout", label: "Breakout", render: (r) => day(r.breakout) },
                { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
                { key: "company", label: "Company", className: "clip", render: (r) => <span className="muted" title={r.company ?? ""}>{r.company}</span> },
                { key: "name", label: "Pattern" },
                { key: "direction", label: "Type", render: (r) => <DirectionChip direction={r.direction} /> },
                { key: "breakout_price", label: "Breakout at", align: "right", render: (r) => price(r.breakout_price) },
                { key: "level", label: "Through", align: "right", title: "Neckline, rim or flat side", render: (r) => price(r.level) },
                { key: "target", label: "Target", align: "right", title: "Textbook measured move: the pattern's height from the breakout level", render: (r) => price(r.target) },
                {
                  key: "since_breakout",
                  label: "Since",
                  align: "right",
                  title: "Price change from the breakout close to the latest close",
                  render: (r) => <span className={signClass(r.since_breakout)}>{pct(r.since_breakout)}</span>,
                },
                {
                  key: "volume_ratio",
                  label: "Volume",
                  align: "right",
                  title: "Breakout-day volume vs its 50-day average",
                  render: (r) => (r.volume_ratio != null ? `${r.volume_ratio.toFixed(1)}×` : "–"),
                },
                {
                  key: "promoter_net_value",
                  label: "Promoters during it",
                  align: "right",
                  render: (r) =>
                    r.promoter_buys || r.promoter_net_value ? (
                      <span className={signClass(r.promoter_net_value)}>{inr(r.promoter_net_value, true)}</span>
                    ) : (
                      <span className="faint">none</span>
                    ),
                },
              ]}
            />
          </div>
        )}
      </Card>

      <Card
        title="Returns vs Nifty around breakouts"
        actions={
          <select className="select" aria-label="Pattern for the event study" value={studyPattern} onChange={(e) => setStudyPattern(e.target.value)}>
            <option value="all">All patterns, by pattern</option>
            {(s?.patterns ?? []).map((p) => (
              <option key={p.pattern} value={p.pattern}>
                {p.name}: with vs without promoter buying
              </option>
            ))}
          </select>
        }
      >
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Average price path minus Nifty, day 0 = the close after the breakout. Bearish patterns should slope down. Shaded
          bands are 95% confidence intervals.
        </p>
        {study.error ? (
          <ErrorBox error={study.error} />
        ) : !study.data ? (
          <Skeleton height={320} />
        ) : study.data.groups.length === 0 ? (
          <Empty title="Not enough history yet" />
        ) : (
          <div style={{ opacity: study.isFetching ? 0.6 : 1 }}>
            <EventStudyChart groups={study.data.groups} before={study.data.before} after={study.data.after} />
          </div>
        )}
      </Card>
    </>
  );
}
