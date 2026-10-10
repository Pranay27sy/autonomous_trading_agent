import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ColorType, createChart, createSeriesMarkers, LineSeries, type SeriesMarker, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { api, type CompareStock } from "../api";
import { COLORS } from "../components/charts";
import { StockSearch } from "../components/StockSearch";
import { Card, ConvictionBadge, Empty, ErrorBox, Segmented, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, pct, signClass } from "../format";

const LINE_COLORS = ["#f5a524", "#42a5f5", "#ab47bc", "#e6e9ef"];
const RANGES = { "6M": 182, "1Y": 365, "3Y": 1095, Max: null } as const;
type Range = keyof typeof RANGES;
const MAX = 4;

export function Compare() {
  const [f] = useFilters();
  const [params, setParams] = useSearchParams();
  const symbols = (params.get("symbols") ?? "").split(",").filter(Boolean).slice(0, MAX);
  const range = (params.get("range") as Range) in RANGES ? (params.get("range") as Range) : "1Y";
  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true },
    );
  const setSymbols = (s: string[]) => setParam("symbols", s.join(",") || null);

  const stocks = useQuery({ queryKey: ["stocks", f], queryFn: () => api.stocks(f), placeholderData: keepPreviousData });
  const q = useQuery({
    queryKey: ["compare", symbols, range, f],
    queryFn: () => api.compare(symbols, RANGES[range], f),
    enabled: symbols.length > 0,
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="page-head">
        <h1>Compare</h1>
        <span className="muted">Up to {MAX} stocks on one chart, rebased to 0% at the start, with their promoter trades.</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 16 }}>
        {symbols.map((s, i) => (
          <span key={s} className="compare-chip" style={{ borderColor: LINE_COLORS[i] }}>
            <span style={{ color: LINE_COLORS[i] }}>━</span> {s}
            <button type="button" className="btn-link faint" aria-label={`Remove ${s}`} onClick={() => setSymbols(symbols.filter((x) => x !== s))}>
              ✕
            </button>
          </span>
        ))}
        {symbols.length < MAX && (
          <div style={{ width: 300 }}>
            <StockSearch
              stocks={stocks.data ?? []}
              exclude={symbols}
              placeholder={symbols.length ? "Add another stock" : "Add a stock to compare"}
              onPick={(s) => setSymbols([...symbols, s.symbol])}
            />
          </div>
        )}
        <span style={{ marginLeft: "auto" }}>
          <Segmented label="Range" options={Object.keys(RANGES) as Range[]} value={range} onChange={(r) => setParam("range", r === "1Y" ? null : r)} />
        </span>
      </div>
      {symbols.length === 0 ? (
        <Empty title="Pick stocks to compare">
          <p>Search above, or use the most active stocks for your filters:</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {(stocks.data ?? []).slice(0, 6).map((s) => (
              <button key={s.symbol} type="button" className="btn" onClick={() => setSymbols([s.symbol])}>
                {s.symbol}
              </button>
            ))}
          </div>
        </Empty>
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data ? (
        <Skeleton height={420} />
      ) : (
        <div style={{ opacity: q.isFetching ? 0.6 : 1 }}>
          <Card
            title={<span className="legend"><span>▲ promoter buy</span><span>▼ promoter sell</span><span>in each line's colour · {day(q.data.start)} → {day(q.data.end)}</span></span>}
            className="spaced"
          >
            <CompareChart stocks={q.data.stocks} />
          </Card>
          <Card title="Side by side">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Stock</th>
                    <th scope="col">Sector</th>
                    <th scope="col" className="num">Return</th>
                    <th scope="col" className="num">Volatility</th>
                    <th scope="col" className="num">Max drawdown</th>
                    <th scope="col" className="num">Net promoter flow</th>
                    <th scope="col" className="num">Buys / sells</th>
                    <th scope="col">Best conviction</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.stocks.map((s, i) => (
                    <tr key={s.symbol}>
                      <td>
                        <span style={{ color: LINE_COLORS[i] }}>━ </span>
                        <StockLink symbol={s.symbol} /> <span className="muted">{s.company}</span>
                      </td>
                      <td className="muted">{s.sector ?? "–"}</td>
                      {s.stats ? (
                        <>
                          <td className={`num ${signClass(s.stats.return)}`}>{pct(s.stats.return)}</td>
                          <td className="num">{s.stats.volatility != null ? `${(s.stats.volatility * 100).toFixed(0)}%` : "–"}</td>
                          <td className="num neg">{pct(s.stats.max_drawdown)}</td>
                          <td className={`num ${signClass(s.stats.net_value)}`}>{inr(s.stats.net_value, true)}</td>
                          <td className="num">
                            {s.stats.buys} / {s.stats.sells}
                          </td>
                          <td>
                            <ConvictionBadge score={s.stats.max_conviction} />
                          </td>
                        </>
                      ) : (
                        <td colSpan={6} className="faint">
                          no price data
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="card-note">Volatility is annualised from daily returns. Promoter flow and trades cover the chart's date range.</p>
          </Card>
        </div>
      )}
    </>
  );
}

function CompareChart({ stocks }: { stocks: CompareStock[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.muted,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.grid },
      timeScale: { borderColor: COLORS.grid },
      localization: { priceFormatter: (p: number) => pct(p) },
    });
    stocks.forEach((s, i) => {
      if (!s.path.length) return;
      const color = LINE_COLORS[i] ?? COLORS.accent;
      const line = chart.addSeries(LineSeries, { color, lineWidth: 2, title: s.symbol, priceLineVisible: false });
      line.setData(s.path.map((p) => ({ time: p.time as Time, value: p.value })));
      // Markers must sit on a bar: snap each trade to the last price date on or before it.
      const times = s.path.map((p) => p.time);
      const snap = (t: string) => {
        let lo = 0;
        let hi = times.length - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (times[mid]! <= t) {
            found = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        return found >= 0 ? times[found]! : null;
      };
      const seen = new Set<string>();
      const markers: SeriesMarker<Time>[] = [];
      for (const t of s.trades) {
        const at = snap(t.time);
        const key = `${at}-${t.direction}`;
        if (!at || seen.has(key)) continue;
        seen.add(key);
        markers.push({
          time: at as Time,
          position: t.direction === "buy" ? "belowBar" : "aboveBar",
          shape: t.direction === "buy" ? "arrowUp" : "arrowDown",
          color,
          size: 0.9,
        });
      }
      markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
      createSeriesMarkers(line, markers);
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [stocks]);
  return <div className="chart-box" ref={box} role="img" aria-label="Rebased price comparison" />;
}
