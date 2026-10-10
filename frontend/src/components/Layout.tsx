import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { api } from "../api";
import { MIN_VALUES, PERIODS, useFilters } from "../filters";
import { ago, day, inr } from "../format";
import { Segmented, Switch } from "./ui";
import { AlertBell } from "./watch";

export function Layout() {
  const { search } = useLocation();
  return (
    <>
      <header className="topbar">
        <NavLink to={{ pathname: "/", search }} className="brand" aria-label="Promoter tracker home">
          <span className="brand-mark">▲▼</span>
          <span className="brand-name">
            PROMOTER<span className="brand-sub">/TRACKER</span>
          </span>
        </NavLink>
        <nav className="nav" aria-label="Pages">
          <NavLink to={{ pathname: "/", search }} end>
            Overview
          </NavLink>
          <NavLink to={{ pathname: "/trades", search }}>Trades</NavLink>
          <NavLink to={{ pathname: "/stock", search }}>Stock</NavLink>
          <NavLink to={{ pathname: "/watchlist", search }}>Watchlist</NavLink>
        </nav>
        <div className="topbar-right">
          <Bell />
          <RefreshControl />
        </div>
      </header>
      <FilterBar />
      <main>
        <Outlet />
      </main>
      <footer className="footer">
        Data: NSE insider-trading (SEBI PIT) disclosures and Yahoo Finance prices, both unofficial free sources.
        Disclosures can lag trades by ~4 trading days. For research only, not investment advice.
      </footer>
    </>
  );
}

function Bell() {
  // Same query as RefreshControl's; React Query shares it, so this adds no requests.
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  return <AlertBell unread={status.data?.unread_alerts ?? 0} />;
}

function FilterBar() {
  const [f, update] = useFilters();
  const toggleSide = (side: "buy" | "sell") =>
    update({ sides: f.sides.includes(side) ? f.sides.filter((s) => s !== side) : [...f.sides, side].sort() });
  return (
    <div className="filterbar" role="search" aria-label="Filters">
      <div className="filter">
        <span className="filter-label">Period</span>
        <Segmented label="Period" options={PERIODS} value={f.period} onChange={(period) => update({ period })} />
      </div>
      <div className="filter">
        <span className="filter-label">Side</span>
        <div className="seg sides" role="group" aria-label="Side">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} type="button" data-side={s} aria-pressed={f.sides.includes(s)} onClick={() => toggleSide(s)}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="filter">
        <label className="filter-label" htmlFor="min-value">
          Min value
        </label>
        <select
          id="min-value"
          className="select"
          value={MIN_VALUES.includes(f.minValue as (typeof MIN_VALUES)[number]) ? f.minValue : ""}
          onChange={(e) => update({ minValue: Number(e.target.value) })}
        >
          {!MIN_VALUES.includes(f.minValue as (typeof MIN_VALUES)[number]) && <option value="">{inr(f.minValue)}</option>}
          {MIN_VALUES.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? "Any" : inr(v).replace(".0 ", " ")}
            </option>
          ))}
        </select>
      </div>
      <div className="filter">
        <span className="filter-label">Returns from</span>
        <Segmented
          label="Measure returns from"
          options={["disclosure_date", "trade_to"] as const}
          value={f.basis}
          format={(b) => (b === "disclosure_date" ? "Disclosure" : "Trade date")}
          onChange={(basis) => update({ basis })}
        />
      </div>
      <Switch
        label="Open-market only"
        checked={f.marketOnly}
        onChange={(marketOnly) => update({ marketOnly })}
        title="Drop gifts, off-market transfers, ESOPs, pledges and similar entries"
      />
    </div>
  );
}

function RefreshControl() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (q) => (q.state.data?.refresh.running ? 1500 : 60_000),
  });
  const start = useMutation({
    mutationFn: () => api.refresh(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });

  // When a refresh finishes, everything derived from the data is stale.
  const running = status.data?.refresh.running ?? false;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "status" });
    wasRunning.current = running;
  }, [running, qc]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const s = status.data;
  const r = s?.refresh;
  const dot = running ? "running" : s?.stale ? "stale" : "";
  return (
    <div className="popover-anchor" ref={anchor}>
      <button
        className="btn"
        type="button"
        aria-expanded={open}
        aria-label={running ? "Refreshing data" : `Data up to ${day(s?.prices_through)}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`status-dot ${dot}`} />
        <span className="refresh-label">{running ? "Refreshing…" : `Data to ${throughLabel(s?.prices_through)}`}</span>
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Data refresh">
          <div className="card-head" style={{ marginBottom: 6 }}>
            <h2>Data</h2>
            <button className="btn" type="button" disabled={running || start.isPending} onClick={() => start.mutate()}>
              ↻ Refresh now
            </button>
          </div>
          <div className="muted" style={{ fontSize: 12, display: "grid", gap: 4 }}>
            <div style={{ color: "var(--text)" }}>
              Disclosures to {day(s?.disclosures_through)} · prices to {day(s?.prices_through)}
            </div>
            <div>
              Last successful refresh: {s?.last_refresh ? new Date(s.last_refresh).toLocaleString("en-IN") : "never"}
              {s?.stale && !running && <span style={{ color: "var(--warn)" }}> · stale</span>}
            </div>
            {!running && s?.last_attempt && (!s.last_refresh || s.last_attempt > s.last_refresh) && (
              <div style={{ color: "var(--warn)" }}>
                The latest attempt ({ago(s.last_attempt)}) didn't finish cleanly. Refresh again, or check the refresh log.
              </div>
            )}
            {!!s?.failed_filings && (
              <div>
                {s.failed_filings} {s.failed_filings === 1 ? "filing" : "filings"} failed to download; retried on the
                next refresh.
              </div>
            )}
          </div>
          {r && r.state !== "idle" && (
            <>
              {r.result && (
                <div style={{ marginTop: 10, fontSize: 13 }}>
                  {r.result.new_trades} new disclosures · {r.result.price_rows} price rows
                  {[...r.result.errors, ...r.result.warnings].map((m) => (
                    <div key={m} className="neg" style={{ marginTop: 4 }}>
                      {m}
                    </div>
                  ))}
                </div>
              )}
              {r.log.length > 0 && <pre className="log">{r.log.slice(-12).join("\n")}</pre>}
            </>
          )}
          {start.error && <div className="neg">{String(start.error)}</div>}
        </div>
      )}
    </div>
  );
}

/** "09 Oct" for a recent date, "09 Oct 25" for an older one. */
function throughLabel(iso: string | null | undefined): string {
  if (!iso) return "–";
  const full = day(iso, true);
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? full.slice(0, 6) : full;
}
