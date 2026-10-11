import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PatternPerf, type PatternRow } from "../api";
import { DataTable } from "../components/DataTable";
import { EventStudyChart } from "../components/researchCharts";
import { Card, Empty, ErrorBox, QualityBadge, Segmented, Skeleton, StatusChip, StockLink, Switch } from "../components/ui";
import { day, inr, integer, pct, price, signClass } from "../format";

export function DirectionChip({ direction }: { direction: "bull" | "bear" }) {
  return <span className={`chip ${direction === "bull" ? "buy" : "sell"}`}>{direction === "bull" ? "bullish ↑" : "bearish ↓"}</span>;
}

function Worked({ p }: { p: PatternPerf }) {
  if (!p.n) return <span className="faint">–</span>;
  return (
    <span className={(p.worked_60 ?? 0) > 0.5 ? "pos" : "neg"} title={`avg ${pct(p.mean_60)} · n=${p.n}`}>
      {Math.round((p.worked_60 ?? 0) * 100)}%<span className="faint"> ({integer(p.n)})</span>
    </span>
  );
}

const QUALITY_OPTIONS = [0, 50, 70] as const;

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
  const [minQuality, setMinQuality] = useState<(typeof QUALITY_OPTIONS)[number]>(50);
  const [studySplit, setStudySplit] = useState<"auto" | "quality">("auto");
  const stats = useQuery({ queryKey: ["pattern-stats", minQuality], queryFn: () => api.patternStats(minQuality), placeholderData: keepPreviousData });
  const recent = useQuery({
    queryKey: ["patterns-recent", days, direction, pattern, promoterOnly, minQuality],
    queryFn: () => api.recentPatterns(days, direction, pattern, promoterOnly, minQuality),
    placeholderData: keepPreviousData,
  });
  const formingQ = useQuery({
    queryKey: ["patterns-forming", direction, pattern, minQuality],
    queryFn: () => api.recentPatterns(365, direction, pattern, false, minQuality, true),
    placeholderData: keepPreviousData,
  });
  const split = studySplit === "quality" ? "quality" : studyPattern === "all" ? "pattern" : "promoter";
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
          Classic patterns found by explicit rules on daily highs, lows and closes, with how each one actually did on these
          stocks.
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span className="filter-label">Min quality</span>
          <Segmented
            label="Minimum quality"
            options={QUALITY_OPTIONS}
            value={minQuality}
            onChange={setMinQuality}
            format={(q) => (q ? `${q}+` : "Any")}
          />
        </span>
      </div>
      <details className="card spaced how">
        <summary>How patterns are found, and what the quality score means</summary>
        <ul>
          <li>
            <b>Swing points</b> are a day's high (or low) that is the extreme within 5 trading days either side. A swing must
            move at least 2.5× the stock's average daily range (3–15%), so volatile and calm stocks are judged on their own
            terms.
          </li>
          <li>
            <b>Context:</b> reversal patterns need a trend to reverse. A head and shoulders or double top needs a 15%+ rise
            into it, and a cup and handle a 25%+ advance.
          </li>
          <li>
            <b>Shape rules:</b> matching shoulders in height and timing, minimum and maximum durations, triangles with three
            touches of a flat side and a narrowing range.
          </li>
          <li>
            <b>Breakout:</b> the first close beyond the neckline, rim or flat side by half a day's typical range, after the
            last swing could have been known. Nothing looks into the future.
          </li>
          <li>
            <b>Lifecycle:</b> after the breakout, <i>target hit</i> (the textbook measured move) or <i>failed</i> (price went
            back past the right shoulder, second top, handle low…), whichever came first.
          </li>
          <li>
            <b>Quality (0–100)</b> scores how textbook a pattern is: the trend into it, shape, prominence, breakout strength,
            volume and duration. On this data, <b>higher quality did not predict better returns</b> (see the tiers below). It
            tells you how clean a pattern looks, not whether it will work.
          </li>
        </ul>
      </details>

      <Card title="How each pattern performed after its breakout" className="spaced">
        {!s ? (
          <Skeleton height={260} />
        ) : s.total === 0 ? (
          <Empty title="No patterns yet">The first scan runs in the background after the server starts.</Empty>
        ) : (
          <>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
              "Worked" = the stock moved the pattern's way vs Nifty 50 over the 60 trading days after the breakout (up for
              bullish, down for bearish). {integer(s.total)} patterns{minQuality ? ` scoring ${minQuality}+` : ""},{" "}
              {day(s.from)} → {day(s.to)}; {integer(s.forming)} forming now.
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
                    <th scope="col" className="num" title="Of patterns that resolved, the share that reached the target before failing">
                      Target hit
                    </th>
                    <th scope="col">With promoter buying</th>
                    <th scope="col">Without</th>
                    <th scope="col" className="num" title="Worked (60d) by quality tier, regardless of the minimum quality filter">
                      High · Med · Low quality
                    </th>
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
                      <td className="num">{p.all.target_hit != null ? `${Math.round(p.all.target_hit * 100)}%` : "–"}</td>
                      <td>
                        <Perf p={p.promoter} />
                      </td>
                      <td>
                        <Perf p={p.no_promoter} />
                      </td>
                      <td className="num">
                        <Worked p={p.tiers.High} /> · <Worked p={p.tiers.Medium} /> · <Worked p={p.tiers.Low} />
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
                { key: "quality", label: "Quality", render: (r) => <QualityBadge score={r.quality} reasons={r.quality_reasons} /> },
                { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
                { key: "company", label: "Company", className: "clip", render: (r) => <span className="muted" title={r.company ?? ""}>{r.company}</span> },
                { key: "name", label: "Pattern" },
                { key: "direction", label: "Type", render: (r) => <DirectionChip direction={r.direction} /> },
                { key: "status", label: "Status", render: (r) => <StatusChip status={r.status} /> },
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

      <Card title="Forming now: shape complete, waiting for a breakout (closest first)" className="spaced">
        {formingQ.error ? (
          <ErrorBox error={formingQ.error} />
        ) : !formingQ.data ? (
          <Skeleton height={200} />
        ) : formingQ.data.rows.length === 0 ? (
          <Empty title="Nothing forming at this quality" />
        ) : (
          <DataTable<PatternRow>
            rows={formingQ.data.rows}
            rowKey={(r) => `${r.symbol}-${r.pattern}-${r.start}`}
            pageSize={15}
            columns={[
              { key: "quality", label: "Quality", render: (r) => <QualityBadge score={r.quality} reasons={r.quality_reasons} /> },
              { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
              { key: "company", label: "Company", className: "clip", render: (r) => <span className="muted" title={r.company ?? ""}>{r.company}</span> },
              { key: "name", label: "Pattern" },
              { key: "direction", label: "If it breaks", render: (r) => <DirectionChip direction={r.direction} /> },
              { key: "level", label: "Breaks at", align: "right", title: "The level a close must clear (plus half a day's range)", render: (r) => price(r.level) },
              {
                key: "distance",
                label: "Away",
                align: "right",
                title: "Last close vs the breakout level",
                render: (r) => <span className="mono">{pct(r.distance)}</span>,
              },
              { key: "last_close", label: "Last", align: "right", render: (r) => price(r.last_close) },
              { key: "invalidation", label: "Invalid past", align: "right", title: "If price closes beyond this first, the setup is off", render: (r) => price(r.invalidation) },
            ]}
          />
        )}
        <p className="card-note">Not a prediction that they will break out, or which way the stock goes next.</p>
      </Card>

      <Card
        title="Returns vs Nifty around breakouts"
        actions={
          <span style={{ display: "flex", gap: 8 }}>
          <Segmented
            label="Split"
            options={["auto", "quality"] as const}
            value={studySplit}
            onChange={setStudySplit}
            format={(x) => (x === "auto" ? (studyPattern === "all" ? "By pattern" : "By promoter buying") : "By quality")}
          />
          <select className="select" aria-label="Pattern for the event study" value={studyPattern} onChange={(e) => setStudyPattern(e.target.value)}>
            <option value="all">All patterns</option>
            {(s?.patterns ?? []).map((p) => (
              <option key={p.pattern} value={p.pattern}>
                {p.name}
              </option>
            ))}
          </select>
          </span>
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
