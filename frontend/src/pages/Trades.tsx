import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { Empty, ErrorBox, Skeleton, Switch } from "../components/ui";
import { useFilters } from "../filters";
import { integer } from "../format";
import { ALL_RETURNS, KEY_RETURNS, tradeColumns, tradesCsv } from "../tradeColumns";

export function Trades() {
  const [f] = useFilters();
  const [search, setSearch] = useState("");
  const [allHorizons, setAllHorizons] = useState(false);
  const q = useQuery({ queryKey: ["trades", f], queryFn: () => api.trades(f), placeholderData: keepPreviousData });
  const needle = useDeferredValue(search.trim().toLowerCase());

  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (!needle) return all;
    return all.filter((t) => `${t.symbol} ${t.company ?? ""} ${t.person ?? ""}`.toLowerCase().includes(needle));
  }, [q.data, needle]);

  const columns = useMemo(
    () =>
      tradeColumns([
        "event_date", "symbol", "direction", "company", "person", "mode", "value", "quantity",
        "conviction", "holding_after_pct", "holding_change_pct", ...(allHorizons ? ALL_RETURNS : KEY_RETURNS),
      ]),
    [allHorizons],
  );

  const download = () => {
    const url = URL.createObjectURL(new Blob([tradesCsv(rows)], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `promoter-trades-${f.period}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <div className="page-head">
        <h1>Promoter trades</h1>
        <span className="muted">
          {q.data ? `${integer(rows.length)}${needle ? ` of ${integer(q.data.total)}` : ""} trades · newest first` : "Loading…"}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <input
          className="input"
          type="search"
          placeholder="Search symbol, company or promoter"
          aria-label="Search trades"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "min(360px, 100%)" }}
        />
        <Switch label="All return horizons" checked={allHorizons} onChange={setAllHorizons} />
        <button className="btn" type="button" onClick={download} disabled={!rows.length} style={{ marginLeft: "auto" }}>
          ↓ CSV
        </button>
      </div>
      {!q.data ? (
        <Skeleton height={480} />
      ) : rows.length === 0 ? (
        <Empty title="No trades match">
          <p>Try a different search or widen the filters.</p>
        </Empty>
      ) : (
        <div style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
          <DataTable rows={rows} columns={columns} rowKey={(t, i) => `${t.symbol}-${t.event_date}-${t.person}-${i}`} pageSize={100} tall />
        </div>
      )}
      <p className="card-note">Returns not known yet (the trade is too recent) show as –. Click a symbol to open its chart.</p>
    </>
  );
}
