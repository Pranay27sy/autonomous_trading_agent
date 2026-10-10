import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { api } from "../api";
import { DEFAULT_FILTERS } from "../filters";
import { ago } from "../format";

/** The watched symbols, shared by every star button. */
export function useWatched(): Set<string> {
  // The list itself doesn't depend on filters; fetch it once with the defaults.
  const q = useQuery({ queryKey: ["watchlist", "symbols"], queryFn: () => api.watchlist(DEFAULT_FILTERS) });
  return new Set((q.data ?? []).map((w) => w.symbol));
}

export function WatchButton({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const watching = useWatched().has(symbol);
  const toggle = useMutation({
    mutationFn: () => (watching ? api.unwatch(symbol) : api.watch(symbol)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
  });
  return (
    <button
      className={`btn star ${watching ? "on" : ""}`}
      type="button"
      aria-pressed={watching}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      title={watching ? "Stop watching (no more alerts for every trade)" : "Watch: get an alert for every promoter trade"}
    >
      {watching ? "★ Watching" : "☆ Watch"}
    </button>
  );
}

/** Bell in the top bar: unread count, the latest alerts, mark all read. */
export function AlertBell({ unread }: { unread: number }) {
  const qc = useQueryClient();
  const { search } = useLocation();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useQuery({ queryKey: ["alerts", "latest"], queryFn: () => api.alerts(8), enabled: open });
  const readAll = useMutation({
    mutationFn: () => api.markRead(),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "alerts" || q.queryKey[0] === "status" }),
  });

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

  return (
    <div className="popover-anchor" ref={anchor}>
      <button
        className="btn bell"
        type="button"
        aria-expanded={open}
        aria-label={unread ? `${unread} unread alerts` : "Alerts"}
        onClick={() => setOpen(!open)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Alerts">
          <div className="card-head" style={{ marginBottom: 8 }}>
            <h2>Alerts</h2>
            <button className="btn" type="button" disabled={!unread || readAll.isPending} onClick={() => readAll.mutate()}>
              Mark all read
            </button>
          </div>
          {list.data?.alerts.length === 0 && (
            <p className="muted" style={{ fontSize: 13 }}>
              No alerts yet. They appear after a refresh finds new promoter trades that match your rules.
            </p>
          )}
          <ul className="alert-list compact">
            {list.data?.alerts.map((a) => (
              <li key={a.id} className={a.read ? "" : "unread"}>
                <Link to={{ pathname: `/stock/${encodeURIComponent(a.symbol)}`, search }} onClick={() => setOpen(false)}>
                  <span className={`chip ${a.kind === "cluster" ? "buy" : (a.direction ?? "neutral")}`}>{KIND_LABEL[a.kind]}</span>
                  <span className="alert-title">{a.title}</span>
                </Link>
                <span className="faint alert-time">{ago(a.created_at)}</span>
              </li>
            ))}
          </ul>
          <Link className="btn-link" style={{ fontSize: 12 }} to={{ pathname: "/alerts", search }} onClick={() => setOpen(false)}>
            All alerts and settings →
          </Link>
        </div>
      )}
    </div>
  );
}

export const KIND_LABEL = { watchlist: "watch", big_buy: "big buy", big_sell: "big sell", cluster: "cluster" } as const;
