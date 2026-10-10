import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { api, type WatchItem } from "../api";
import { DataTable } from "../components/DataTable";
import { Card, Empty, ErrorBox, SideChip, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, pct, price, signClass } from "../format";

export function Watchlist() {
  const [f] = useFilters();
  const { search } = useLocation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["watchlist", f], queryFn: () => api.watchlist(f) });
  const remove = useMutation({
    mutationFn: (symbol: string) => api.unwatch(symbol),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
  });

  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <div className="page-head">
        <h1>Watchlist</h1>
        <span className="muted">You get an alert for every promoter trade in these stocks.</span>
      </div>
      {!q.data ? (
        <Skeleton height={240} />
      ) : q.data.length === 0 ? (
        <Empty title="Nothing on your watchlist yet">
          <p>
            Open a stock and click <b>☆ Watch</b>. Start from the{" "}
            <Link className="btn-link" to={{ pathname: "/stock", search }}>
              most active stock
            </Link>{" "}
            or the buying clusters on the{" "}
            <Link className="btn-link" to={{ pathname: "/", search }}>
              overview
            </Link>
            .
          </p>
        </Empty>
      ) : (
        <Card>
          <DataTable<WatchItem>
            rows={q.data}
            rowKey={(r) => r.symbol}
            initialSort={{ key: "last_trade", desc: true }}
            columns={[
              { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
              {
                key: "company",
                label: "Company",
                className: "clip",
                render: (r) => <span className="muted" title={r.company ?? ""}>{r.company}</span>,
              },
              {
                key: "last_trade",
                label: "Latest promoter trade",
                sortValue: (r) => r.last_trade?.event_date ?? null,
                render: (r) =>
                  r.last_trade ? (
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      <SideChip side={r.last_trade.direction} />
                      <span className="mono">{inr(r.last_trade.value)}</span>
                      <span className="muted">{day(r.last_trade.event_date)}</span>
                    </span>
                  ) : (
                    <span className="faint">none for these filters</span>
                  ),
              },
              {
                key: "net_value_90d",
                label: "Net flow 90d",
                align: "right",
                title: "Promoter buys minus sells over the last 90 days of data",
                render: (r) => <span className={signClass(r.net_value_90d)}>{r.net_value_90d ? inr(r.net_value_90d, true) : "–"}</span>,
              },
              { key: "trades_90d", label: "Trades 90d", align: "right" },
              { key: "last_close", label: "Last close", align: "right", render: (r) => price(r.last_close) },
              {
                key: "change_1m",
                label: "1M",
                align: "right",
                render: (r) => <span className={signClass(r.change_1m)}>{pct(r.change_1m)}</span>,
              },
              {
                key: "remove",
                label: "",
                sortValue: () => null,
                render: (r) => (
                  <button
                    className="btn-link faint"
                    type="button"
                    aria-label={`Stop watching ${r.symbol}`}
                    title="Stop watching"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(r.symbol)}
                  >
                    ✕
                  </button>
                ),
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}
