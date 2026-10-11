import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { api, ApiError, type PersonRow } from "../api";
import { DataTable } from "../components/DataTable";
import { Card, Empty, ErrorBox, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, integer, pct, percentPoints, signClass } from "../format";
import { ALL_RETURNS, tradeColumns } from "../tradeColumns";

/** Same rule as service.person_slug on the server. */
export function personSlug(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function PersonLink({ name }: { name: string | null }) {
  const { search } = useLocation();
  const slug = personSlug(name);
  if (!name || !slug) return <span>{name ?? "–"}</span>;
  return (
    <Link className="person-link" to={{ pathname: `/people/${slug}`, search }} title={`${name}: all trades and track record`}>
      {name}
    </Link>
  );
}

function Track({ value, hit, n }: { value: number | null; hit: number | null; n: number }) {
  if (!n) return <span className="faint">no scored buys</span>;
  return (
    <span>
      <span className={`mono ${signClass(value)}`}>{pct(value)}</span>
      <span className="muted"> · beat Nifty {Math.round((hit ?? 0) * 100)}% · n={n}</span>
    </span>
  );
}

export function People() {
  const [f] = useFilters();
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());
  const q = useQuery({ queryKey: ["people", f], queryFn: () => api.people(f), placeholderData: keepPreviousData });
  const rows = useMemo(
    () => (q.data ?? []).filter((p) => !needle || `${p.name} ${p.top_company}`.toLowerCase().includes(needle)),
    [q.data, needle],
  );

  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <div className="page-head">
        <h1>Promoters</h1>
        <span className="muted">
          Ranked by how their stocks did vs Nifty 60 trading days after they bought (people with 3+ scored buys first).
        </span>
      </div>
      <input
        className="input"
        type="search"
        placeholder="Search a promoter or symbol"
        aria-label="Search promoters"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: "min(360px, 100%)", marginBottom: 12 }}
      />
      {!q.data ? (
        <Skeleton height={480} />
      ) : rows.length === 0 ? (
        <Empty title="No promoters match" />
      ) : (
        <div style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
          <DataTable<PersonRow>
            rows={rows}
            rowKey={(p) => p.slug}
            pageSize={50}
            tall
            columns={[
              { key: "name", label: "Promoter", className: "clip", render: (p) => <PersonLink name={p.name} /> },
              { key: "top_company", label: "Main stock", render: (p) => (p.top_company ? <StockLink symbol={p.top_company} /> : "–") },
              { key: "companies", label: "Stocks", align: "right" },
              { key: "trades", label: "Trades", align: "right" },
              { key: "buy_value", label: "Bought", align: "right", render: (p) => inr(p.buy_value) },
              { key: "net_value", label: "Net", align: "right", render: (p) => <span className={signClass(p.net_value)}>{inr(p.net_value, true)}</span> },
              {
                key: "exc_60",
                label: "After their buys · +60d vs Nifty",
                sortValue: (p) => (p.n_60 ? p.exc_60 : null),
                render: (p) => <Track value={p.exc_60} hit={p.hit_60} n={p.n_60} />,
              },
              { key: "last_trade", label: "Last trade", align: "right", render: (p) => day(p.last_trade, true) },
            ]}
          />
        </div>
      )}
    </>
  );
}

export function Person() {
  const { slug = "" } = useParams();
  const [f] = useFilters();
  const q = useQuery({ queryKey: ["person", slug, f], queryFn: () => api.person(slug, f) });

  if (q.error) {
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <Empty title="No trades for this promoter">
        <p>Try turning off "Open-market only" or "Hide group transfers".</p>
      </Empty>
    ) : (
      <ErrorBox error={q.error} />
    );
  }
  if (!q.data) return <Skeleton height={480} />;
  const p = q.data;
  const t = p.track;
  return (
    <>
      <div className="page-head">
        <h1>{p.name}</h1>
        <span className="muted">{p.category}</span>
      </div>
      {p.aliases.length > 1 && (
        <p className="muted" style={{ margin: "-8px 0 16px", fontSize: 12 }}>
          Also filed as: {p.aliases.filter((a) => a !== p.name).join(" · ")}
        </p>
      )}
      <div className="grid kpis">
        <Card>
          <div className="kpi-label">Activity</div>
          <div className="kpi-value">{integer(p.trades)} trades</div>
          <div className="kpi-sub">
            bought {inr(p.buy_value)} · sold {inr(p.sell_value)} · {p.companies.length} stock{p.companies.length === 1 ? "" : "s"}
          </div>
        </Card>
        {([20, 60, 120] as const).map((h) => (
          <Card key={h}>
            <div className="kpi-label">After their buys · +{h}d vs Nifty</div>
            <div className={`kpi-value ${signClass(t[`exc_${h}`])}`}>{pct(t[`exc_${h}`])}</div>
            <div className="kpi-sub">
              {t[`n_${h}`] ? `beat Nifty ${Math.round((t[`hit_${h}`] ?? 0) * 100)}% of ${t[`n_${h}`]} buys` : "no buys old enough yet"}
            </div>
          </Card>
        ))}
      </div>
      <div className="grid two-one">
        <Card title="Trades">
          <DataTable
            rows={p.trades_list}
            rowKey={(r, i) => `${r.symbol}-${r.event_date}-${i}`}
            pageSize={25}
            columns={tradeColumns(["event_date", "symbol", "direction", "mode", "value", "conviction", "holding_change_pct", ...ALL_RETURNS.filter((k) => k.startsWith("exc"))])}
          />
        </Card>
        <Card title="Stocks">
          <DataTable
            rows={p.companies}
            rowKey={(c) => c.symbol}
            columns={[
              { key: "symbol", label: "Symbol", render: (c) => <StockLink symbol={c.symbol} /> },
              { key: "trades", label: "Trades", align: "right" },
              { key: "net_value", label: "Net", align: "right", render: (c) => <span className={signClass(c.net_value)}>{inr(c.net_value, true)}</span> },
              { key: "holding_after_pct", label: "Holding", align: "right", render: (c) => (c.holding_after_pct != null ? `${percentPoints(c.holding_after_pct)}%` : "–") },
              { key: "last", label: "Last", align: "right", render: (c) => day(c.last, true) },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
