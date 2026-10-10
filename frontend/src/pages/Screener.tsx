import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ScreenCriteria, type ScreenRow } from "../api";
import { DataTable } from "../components/DataTable";
import { Card, Chips, ConvictionBadge, Empty, ErrorBox, Segmented, Skeleton, StockLink, Switch } from "../components/ui";
import { WatchButton } from "../components/watch";
import { useFilters } from "../filters";
import { day, inr, pct, signClass } from "../format";

const DEFAULT: ScreenCriteria = {
  lookback_days: 90,
  min_net_value: null,
  min_buys: null,
  min_promoters: null,
  min_conviction: null,
  min_below_high: null,
  max_change_3m: null,
  sectors: [],
  caps: [],
  exclude_pledge_risk: false,
  sort: "net_value",
};
const CAPS = ["Large cap", "Mid cap", "Small cap", "Micro cap"];
const RISK_CHIP = { high: "sell", rising: "neutral", flat: "neutral", easing: "buy" } as const;

/** A select whose "Any" option means null. */
function Pick<T extends number>(props: {
  label: string;
  value: T | null;
  options: T[];
  format: (v: T) => string;
  onChange: (v: T | null) => void;
}) {
  return (
    <label className="field">
      <span className="filter-label">{props.label}</span>
      <select
        className="select"
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? null : (Number(e.target.value) as T))}
      >
        <option value="">Any</option>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {props.format(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Screener() {
  const [f] = useFilters();
  const qc = useQueryClient();
  const [c, setC] = useState<ScreenCriteria>(DEFAULT);
  const [name, setName] = useState("");
  const [alert, setAlert] = useState(true);
  const set = (patch: Partial<ScreenCriteria>) => setC({ ...c, ...patch });

  const presets = useQuery({ queryKey: ["screen-presets"], queryFn: api.screenPresets, staleTime: Infinity });
  const saved = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const sectors = useQuery({ queryKey: ["sectors", { ...f, period: "All" }], queryFn: () => api.sectors({ ...f, period: "All" }) });
  const q = useQuery({
    queryKey: ["screener", c, f.marketOnly, f.basis],
    queryFn: () => api.runScreen(c, f),
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: () => api.saveScreen(name.trim(), c, alert),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["screens"] });
      setName("");
    },
  });
  const remove = useMutation({ mutationFn: api.deleteScreen, onSuccess: () => qc.invalidateQueries({ queryKey: ["screens"] }) });
  const watchAll = useMutation({
    mutationFn: async (symbols: string[]) => {
      for (const s of symbols) await api.watch(s);
    },
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === "watchlist" || x.queryKey[0] === "screener" }),
  });

  const rows = q.data?.rows ?? [];
  const unwatched = rows.filter((r) => !r.watching).map((r) => r.symbol);
  return (
    <>
      <div className="page-head">
        <h1>Screener</h1>
        <span className="muted">Find stocks by what their promoters are doing, how the price has behaved, and pledge risk.</span>
      </div>
      <div className="screener">
        <div>
          <Card title="Screens" className="spaced">
            <div className="screen-list">
              {Object.entries(presets.data ?? {}).map(([n, crit]) => (
                <button key={n} type="button" className="btn" onClick={() => setC({ ...DEFAULT, ...crit })}>
                  {n}
                </button>
              ))}
            </div>
            {(saved.data ?? []).length > 0 && (
              <>
                <div className="filter-label" style={{ margin: "14px 0 6px" }}>
                  Saved
                </div>
                <ul className="saved-screens">
                  {saved.data!.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="btn-link" onClick={() => setC({ ...DEFAULT, ...s.criteria })}>
                        {s.name}
                      </button>
                      {s.alert && (
                        <span className="chip neutral" title="Alerts when a stock newly matches, after each refresh">
                          alerts
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn-link faint"
                        style={{ marginLeft: "auto" }}
                        aria-label={`Delete screen ${s.name}`}
                        onClick={() => remove.mutate(s.id)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
          <Card title="Criteria">
            <div className="rules">
              <label className="field">
                <span className="filter-label">Promoter activity in the last</span>
                <Segmented
                  label="Look-back"
                  options={[30, 90, 180, 365] as const}
                  value={c.lookback_days as 30 | 90 | 180 | 365}
                  onChange={(lookback_days) => set({ lookback_days })}
                  format={(d) => (d === 365 ? "1Y" : `${d}d`)}
                />
              </label>
              <Pick label="Net promoter buying at least" value={c.min_net_value} options={[0, 1e7, 5e7, 1e8, 5e8]} format={(v) => (v ? inr(v).replace(".0 ", " ") : "₹0 (net buyers)")} onChange={(min_net_value) => set({ min_net_value })} />
              <Pick label="Buys at least" value={c.min_buys} options={[2, 3, 5, 10]} format={(v) => `${v}`} onChange={(min_buys) => set({ min_buys })} />
              <Pick label="Distinct promoters buying" value={c.min_promoters} options={[2, 3, 4, 5]} format={(v) => `${v}+`} onChange={(min_promoters) => set({ min_promoters })} />
              <Pick label="Best conviction at least" value={c.min_conviction} options={[35, 50, 60, 75]} format={(v) => `${v}+`} onChange={(min_conviction) => set({ min_conviction })} />
              <Pick label="Price below 52-week high by" value={c.min_below_high} options={[0.1, 0.2, 0.3, 0.5]} format={(v) => `${v * 100}%+`} onChange={(min_below_high) => set({ min_below_high })} />
              <Pick label="3-month price change at most" value={c.max_change_3m} options={[0.1, 0, -0.1, -0.2]} format={(v) => pct(v, 0)} onChange={(max_change_3m) => set({ max_change_3m })} />
              <Switch label="Skip stocks with a recent pledge invocation" checked={c.exclude_pledge_risk} onChange={(exclude_pledge_risk) => set({ exclude_pledge_risk })} />
              <div className="field">
                <span className="filter-label">Market cap</span>
                <Chips options={CAPS} selected={c.caps} onChange={(caps) => set({ caps })} />
              </div>
              {sectors.data && sectors.data.sectors.length > 1 && (
                <div className="field">
                  <span className="filter-label">Sectors</span>
                  <Chips options={sectors.data.sectors.map((s) => s.sector).filter((s) => s !== "Unclassified")} selected={c.sectors} onChange={(sectors) => set({ sectors })} />
                </div>
              )}
              <button type="button" className="btn-link faint" style={{ justifySelf: "start" }} onClick={() => setC(DEFAULT)}>
                Reset criteria
              </button>
            </div>
            <form
              className="save-screen"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) save.mutate();
              }}
            >
              <input className="input" placeholder="Name this screen" aria-label="Screen name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              <Switch label="Alert on new matches" checked={alert} onChange={setAlert} />
              <button className="btn primary" type="submit" disabled={!name.trim() || save.isPending}>
                Save
              </button>
              {save.data && <span className="pos" style={{ fontSize: 12 }}>Saved · {save.data.matches} match now</span>}
              {save.error && <span className="neg" style={{ fontSize: 12 }}>{save.error.message}</span>}
            </form>
          </Card>
        </div>
        <Card
          title={q.data ? `${rows.length}${rows.length === 200 ? "+" : ""} stocks` : "Results"}
          actions={
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select className="select" aria-label="Sort by" value={c.sort} onChange={(e) => set({ sort: e.target.value as ScreenCriteria["sort"] })}>
                <option value="net_value">Sort: net buying</option>
                <option value="conviction">Sort: conviction</option>
                <option value="promoters">Sort: promoters buying</option>
                <option value="below_high">Sort: furthest below high</option>
                <option value="change_3m">Sort: weakest 3 months</option>
              </select>
              <button className="btn" type="button" disabled={!unwatched.length || unwatched.length > 25 || watchAll.isPending} onClick={() => watchAll.mutate(unwatched)} title={unwatched.length > 25 ? "Narrow the screen to 25 or fewer to watch them all" : undefined}>
                ☆ Watch all ({unwatched.length})
              </button>
            </span>
          }
        >
          {q.error ? (
            <ErrorBox error={q.error} />
          ) : !q.data ? (
            <Skeleton height={420} />
          ) : rows.length === 0 ? (
            <Empty title="No stocks match">
              <p>Loosen a criterion or two.</p>
            </Empty>
          ) : (
            <div style={{ opacity: q.isFetching ? 0.6 : 1 }}>
              <DataTable<ScreenRow>
                rows={rows}
                rowKey={(r) => r.symbol}
                pageSize={50}
                tall
                columns={[
                  { key: "watch", label: "", sortValue: () => null, render: (r) => <WatchButton symbol={r.symbol} /> },
                  { key: "symbol", label: "Symbol", render: (r) => <StockLink symbol={r.symbol} /> },
                  { key: "company", label: "Company", className: "clip", render: (r) => <span className="muted" title={`${r.company ?? ""} · ${r.sector ?? ""}`}>{r.company}</span> },
                  { key: "net_value", label: "Net flow", align: "right", render: (r) => <span className={signClass(r.net_value)}>{inr(r.net_value, true)}</span> },
                  { key: "buys", label: "Buys", align: "right" },
                  { key: "promoters", label: "Promoters", align: "right" },
                  { key: "conviction", label: "Conviction", render: (r) => <ConvictionBadge score={r.conviction} /> },
                  { key: "below_high", label: "Below high", align: "right", render: (r) => (r.below_high != null ? `${(r.below_high * 100).toFixed(0)}%` : "–") },
                  { key: "change_3m", label: "3M", align: "right", render: (r) => <span className={signClass(r.change_3m)}>{pct(r.change_3m)}</span> },
                  { key: "last_trade", label: "Last trade", align: "right", render: (r) => day(r.last_trade, true) },
                  {
                    key: "pledge_risk",
                    label: "Pledges",
                    render: (r) => (r.pledge_risk ? <span className={`chip ${RISK_CHIP[r.pledge_risk]}`}>{r.pledge_risk}</span> : <span className="faint">–</span>),
                  },
                ]}
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
