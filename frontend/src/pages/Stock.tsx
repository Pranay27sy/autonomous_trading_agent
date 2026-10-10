import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError, type StockDetail, type StockListItem } from "../api";
import { DataTable } from "../components/DataTable";
import { PriceChart, type Interval } from "../components/PriceChart";
import { Card, Empty, ErrorBox, Segmented, Skeleton } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, pct, percentPoints, price } from "../format";
import { tradeColumns } from "../tradeColumns";

const RANGES = ["1Y", "3Y", "5Y", "Max"] as const;
type Range = (typeof RANGES)[number];

export function Stock() {
  const { symbol } = useParams();
  const { search } = useLocation();
  const [f] = useFilters();
  const stocks = useQuery({ queryKey: ["stocks", f], queryFn: () => api.stocks(f), placeholderData: keepPreviousData });

  // /stock with no symbol opens the most active stock for the current filters.
  if (!symbol) {
    if (stocks.error) return <ErrorBox error={stocks.error} />;
    if (!stocks.data) return <Skeleton height={420} />;
    const first = stocks.data[0];
    if (!first) return <Empty title="No stocks yet">Refresh the data from the menu at the top right.</Empty>;
    return <Navigate replace to={{ pathname: `/stock/${encodeURIComponent(first.symbol)}`, search }} />;
  }
  return <StockView symbol={symbol.toUpperCase()} stocks={stocks.data ?? []} />;
}

function StockView({ symbol, stocks }: { symbol: string; stocks: StockListItem[] }) {
  const [f] = useFilters();
  const [range, setRange] = useState<Range>("1Y");
  const [interval, setCandleInterval] = useState<Interval>("D");
  // Daily candles get too thin to read over long ranges; switch to weekly there.
  const pickRange = (r: Range) => {
    setRange(r);
    setCandleInterval(r === "5Y" || r === "Max" ? "W" : "D");
  };
  const q = useQuery({ queryKey: ["stock", symbol, f], queryFn: () => api.stock(symbol, f), placeholderData: keepPreviousData });

  const prices = useMemo(() => {
    const all = q.data?.prices ?? [];
    const last = all.at(-1);
    if (range === "Max" || !last) return all;
    const cutoff = new Date(last.time);
    cutoff.setFullYear(cutoff.getFullYear() - Number(range[0]));
    const from = cutoff.toISOString().slice(0, 10);
    return all.filter((p) => p.time >= from);
  }, [q.data, range]);
  const trades = useMemo(
    () => (q.data?.trades ?? []).filter((t) => !prices.length || t.event_date >= prices[0]!.time),
    [q.data, prices],
  );

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <StockPicker stocks={stocks} current={symbol} />
      </div>
      {q.error ? (
        q.error instanceof ApiError && q.error.status === 404 ? (
          <Empty title={`No promoter trades for ${symbol}`}>
            <p>Check the symbol, or widen the filters (side, open-market only).</p>
          </Empty>
        ) : (
          <ErrorBox error={q.error} />
        )
      ) : !q.data ? (
        <Skeleton height={520} />
      ) : (
        <div style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
          <div className="page-head">
            <h1>{q.data.company ?? symbol}</h1>
            <span className="muted mono">NSE: {symbol}</span>
          </div>
          <Kpis d={q.data} />
          <Card
            title={<span className="legend"><span className="tri-up">▲ promoter buy</span><span className="tri-down">▼ promoter sell</span><span>size = ₹ value</span></span>}
            actions={
              <span style={{ display: "flex", gap: 8 }}>
                <Segmented
                  label="Candle interval"
                  options={["D", "W"] as const}
                  value={interval}
                  onChange={setCandleInterval}
                  format={(i) => (i === "D" ? "Daily" : "Weekly")}
                />
                <Segmented label="Chart range" options={RANGES} value={range} onChange={pickRange} />
              </span>
            }
          >
            {prices.length ? (
              <>
                <PriceChart bars={prices} trades={trades} interval={interval} />
                {prices.some((p) => p.open == null) && (
                  <p className="card-note">
                    Some older bars only have a closing price (they were cached before candles were stored) and show as
                    flat. The next data refresh downloads full candles for them.
                  </p>
                )}
              </>
            ) : (
              <Empty title="No price data">Yahoo has no prices for {symbol}.NS; it may be delisted.</Empty>
            )}
          </Card>
          <div style={{ marginTop: 16 }}>
            <Card title="Trades and what followed">
              <DataTable
                rows={q.data.trades}
                rowKey={(t, i) => `${t.event_date}-${t.person}-${i}`}
                columns={tradeColumns([
                  "event_date", "direction", "person", "mode", "value", "holding_after_pct", "holding_change_pct",
                  "ret_1", "ret_5", "ret_20", "ret_60", "ret_120", "exc_20", "exc_60", "exc_120",
                ])}
              />
              <p className="card-note">All of this stock's promoter trades in the cached history; the period filter doesn't apply here.</p>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function Kpis({ d }: { d: StockDetail }) {
  const k = d.kpis;
  return (
    <div className="grid kpis">
      <Card>
        <div className="kpi-label">Last close</div>
        <div className="kpi-value">{price(k.last_close)}</div>
        <div className="kpi-sub">
          <span className={`chip ${k.change_1y == null ? "neutral" : k.change_1y >= 0 ? "buy" : "sell"}`}>{pct(k.change_1y)}</span>
          1 year · as of {day(k.last_date)}
        </div>
      </Card>
      <Card>
        <div className="kpi-label">Net promoter flow</div>
        <div className={`kpi-value ${k.net_value >= 0 ? "pos" : "neg"}`}>{inr(k.net_value, true)}</div>
        <div className="kpi-sub">
          {k.buys} buys · {k.sells} sells
        </div>
      </Card>
      <Card>
        <div className="kpi-label" title="The holding of the person in the latest filing, not the whole promoter group">
          Last filer's holding
        </div>
        <div className="kpi-value">{k.last_holding_pct != null ? `${percentPoints(k.last_holding_pct)}%` : "–"}</div>
        <div className="kpi-sub">from the latest disclosure</div>
      </Card>
      <Card>
        <div className="kpi-label">After buys · +60d vs Nifty</div>
        <div className={`kpi-value ${k.after_buys_exc_60 == null ? "" : k.after_buys_exc_60 >= 0 ? "pos" : "neg"}`}>
          {pct(k.after_buys_exc_60)}
        </div>
        <div className="kpi-sub">
          {k.after_buys_n
            ? `beat Nifty ${Math.round((k.after_buys_hit_60 ?? 0) * 100)}% of the time · ${k.after_buys_n} trades`
            : "no buys with 60 days of history"}
        </div>
      </Card>
    </div>
  );
}

/** Type-ahead stock search: symbol or company name, keyboard friendly. */
function StockPicker({ stocks, current }: { stocks: StockListItem[]; current: string }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const list = q
      ? stocks.filter((s) => s.symbol.toLowerCase().startsWith(q) || (s.company ?? "").toLowerCase().includes(q))
      : stocks;
    return list.slice(0, 30);
  }, [stocks, text]);

  const go = (s: StockListItem | undefined) => {
    if (!s) return;
    setText("");
    setOpen(false);
    navigate({ pathname: `/stock/${encodeURIComponent(s.symbol)}`, search });
  };

  return (
    <div className="picker">
      <input
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls="stock-options"
        aria-label="Find a stock"
        placeholder={`${current} · search another stock`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, matches.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter") go(matches[active]);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
      />
      {open && matches.length > 0 && (
        <ul className="picker-list" id="stock-options" role="listbox">
          {matches.map((s, i) => (
            <li key={s.symbol} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={() => go(s)}>
              <span className="sym">{s.symbol}</span>
              <span className="muted">{s.company}</span>
              {s.trades > 0 && <span className="count">{s.trades}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
