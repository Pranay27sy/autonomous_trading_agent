import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type PledgeCompany, type PledgeEvent } from "../api";
import { DataTable } from "../components/DataTable";
import { Card, Empty, ErrorBox, Skeleton, StockLink } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr, integer, percentPoints } from "../format";
import { PersonLink } from "./People";

const KIND_LABEL = { created: "pledged", released: "released", invoked: "invoked" } as const;
const KIND_CHIP = { created: "neutral", released: "buy", invoked: "sell" } as const;
const RISK_CHIP = { high: "sell", rising: "neutral", flat: "neutral", easing: "buy" } as const;
const RISK_TEXT = {
  high: "Lender invoked pledged shares in the last 90 days",
  rising: "More shares pledged than released in this period",
  flat: "Pledges and releases balance out",
  easing: "More shares released than pledged in this period",
} as const;

export function KindChip({ kind }: { kind: PledgeEvent["kind"] }) {
  return <span className={`chip ${KIND_CHIP[kind]}`}>{KIND_LABEL[kind]}</span>;
}

export function Pledges() {
  const [f] = useFilters();
  const q = useQuery({ queryKey: ["pledges", f.period], queryFn: () => api.pledges(f.period), placeholderData: keepPreviousData });

  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  return (
    <>
      <div className="page-head">
        <h1>Pledges</h1>
        <span className="muted">
          Promoters pledge shares as loan collateral. Rising pledges can signal stress; an invocation (the lender
          seizing pledged shares) often means forced selling.
        </span>
      </div>
      {!d ? (
        <Skeleton height={480} />
      ) : d.companies.length === 0 ? (
        <Empty title="No pledge activity in this period" />
      ) : (
        <div style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
          <div className="grid kpis">
            {(["created", "released", "invoked"] as const).map((k) => (
              <Card key={k}>
                <div className="kpi-label">Shares {KIND_LABEL[k]}</div>
                <div className={`kpi-value ${k === "invoked" ? "neg" : k === "released" ? "pos" : ""}`}>{inr(d.totals[k].value)}</div>
                <div className="kpi-sub">
                  {integer(d.totals[k].events)} filings · {integer(d.totals[k].companies)} companies
                </div>
              </Card>
            ))}
          </div>
          <Card title="Companies by pledge risk" className="spaced">
            <DataTable<PledgeCompany>
              rows={d.companies}
              rowKey={(c) => c.symbol}
              pageSize={25}
              columns={[
                {
                  key: "risk",
                  label: "Risk",
                  sortValue: (c) => ["high", "rising", "flat", "easing"].indexOf(c.risk),
                  render: (c) => (
                    <span className={`chip ${RISK_CHIP[c.risk]}`} title={RISK_TEXT[c.risk]}>
                      {c.risk}
                    </span>
                  ),
                },
                { key: "symbol", label: "Symbol", render: (c) => <StockLink symbol={c.symbol} /> },
                { key: "company", label: "Company", className: "clip", render: (c) => <span className="muted" title={c.company ?? ""}>{c.company}</span> },
                { key: "created_value", label: "Pledged", align: "right", render: (c) => inr(c.created_value) },
                { key: "released_value", label: "Released", align: "right", render: (c) => inr(c.released_value) },
                { key: "invoked_value", label: "Invoked", align: "right", render: (c) => <span className={c.invoked_value ? "neg" : ""}>{inr(c.invoked_value)}</span> },
                {
                  key: "net_pct",
                  label: "Net pledged",
                  align: "right",
                  title: "Shares pledged minus released and invoked in this period, as % of the company",
                  sortValue: (c) => c.net_pct ?? c.net_shares / 1e12,
                  render: (c) => (c.net_pct != null ? `${percentPoints(c.net_pct, 2, true)}%` : `${integer(c.net_shares)} sh`),
                },
                { key: "last_event", label: "Last", align: "right", render: (c) => day(c.last_event, true) },
              ]}
            />
          </Card>
          <Card title="Latest pledge filings">
            <DataTable<PledgeEvent>
              rows={d.events}
              rowKey={(e, i) => `${e.trade_key}-${i}`}
              pageSize={25}
              columns={[
                { key: "event_date", label: "Disclosed", render: (e) => day(e.event_date) },
                { key: "symbol", label: "Symbol", render: (e) => <StockLink symbol={e.symbol} /> },
                { key: "kind", label: "Event", render: (e) => <KindChip kind={e.kind} /> },
                { key: "person", label: "Promoter", className: "clip", render: (e) => <PersonLink name={e.person} /> },
                { key: "quantity", label: "Shares", align: "right", render: (e) => integer(e.quantity) },
                { key: "value", label: "Value at close", align: "right", render: (e) => inr(e.value) },
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}

/** Pledge history card for a stock page; renders nothing when there is none. */
export function StockPledges({ events }: { events: PledgeEvent[] }) {
  if (!events.length) return null;
  const invoked = events.filter((e) => e.kind === "invoked").length;
  return (
    <div style={{ marginTop: 16 }}>
      <Card
        title="Promoter pledges"
        actions={invoked ? <span className="chip sell">{invoked} invocation{invoked > 1 ? "s" : ""}</span> : undefined}
      >
        <DataTable<PledgeEvent>
          rows={events}
          rowKey={(e, i) => `${e.trade_key}-${i}`}
          pageSize={10}
          columns={[
            { key: "event_date", label: "Disclosed", render: (e) => day(e.event_date) },
            { key: "kind", label: "Event", render: (e) => <KindChip kind={e.kind} /> },
            { key: "person", label: "Promoter", className: "clip", render: (e) => <PersonLink name={e.person} /> },
            { key: "quantity", label: "Shares", align: "right", render: (e) => integer(e.quantity) },
            { key: "value", label: "Value at close", align: "right", render: (e) => inr(e.value) },
          ]}
        />
      </Card>
    </div>
  );
}
