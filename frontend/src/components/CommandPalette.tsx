import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useFilters } from "../filters";

interface Item {
  kind: "page" | "stock" | "promoter";
  label: string;
  hint: string;
  to: string;
}

const PAGES: [string, string, string][] = [
  ["Overview", "/", "flow, conviction, clusters"],
  ["Trades", "/trades", "every promoter trade"],
  ["Stock", "/stock", "most active stock"],
  ["Screener", "/screener", "find stocks"],
  ["Patterns", "/patterns", "head & shoulders, cup & handle, breakouts"],
  ["Market", "/market", "flow, breadth, sectors"],
  ["Promoters", "/people", "track-record leaderboard"],
  ["Pledges", "/pledges", "pledges and invocations"],
  ["Research: backtest", "/research", "test a rule"],
  ["Research: event study", "/research?tab=event-study", "returns around trades"],
  ["Compare", "/compare", "up to four stocks"],
  ["Watchlist", "/watchlist", "your stocks"],
  ["Alerts", "/alerts", "alerts and rules"],
];

/** Ctrl+K / ⌘K (or "/"): jump to any page, stock or promoter by typing. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { search } = useLocation();
  const [f] = useFilters();
  const stocks = useQuery({ queryKey: ["stocks", f], queryFn: () => api.stocks(f), enabled: open });
  const people = useQuery({ queryKey: ["people", f], queryFn: () => api.people(f), enabled: open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.matches("input, textarea, select") || e.target.isContentEditable);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setText("");
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const q = text.trim().toLowerCase();
    const pages: Item[] = PAGES.map(([label, to, hint]) => ({ kind: "page", label, hint, to }));
    if (!q) return pages;
    const match = (s: string) => s.toLowerCase().includes(q);
    const out: Item[] = pages.filter((p) => match(p.label));
    for (const s of stocks.data ?? []) {
      if (s.symbol.toLowerCase().startsWith(q) || match(s.company ?? ""))
        out.push({ kind: "stock", label: s.symbol, hint: s.company ?? "", to: `/stock/${encodeURIComponent(s.symbol)}` });
      if (out.length > 40) break;
    }
    for (const p of people.data ?? []) {
      if (match(p.name)) out.push({ kind: "promoter", label: p.name, hint: p.top_company ?? "", to: `/people/${p.slug}` });
      if (out.length > 60) break;
    }
    return out;
  }, [text, stocks.data, people.data]);

  if (!open) return null;
  const go = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    const [path, query] = it.to.split("?");
    const p = new URLSearchParams(search);
    if (query) for (const [k, v] of new URLSearchParams(query)) p.set(k, v);
    navigate({ pathname: path, search: p.toString() ? `?${p}` : "" });
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Go to" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="input"
          placeholder="Go to a page, stock or promoter…"
          aria-label="Search pages, stocks and promoters"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter") go(items[active]);
            else if (e.key === "Escape") setOpen(false);
            else return;
            e.preventDefault();
          }}
        />
        <ul role="listbox" aria-label="Results">
          {items.map((it, i) => (
            <li
              key={`${it.kind}-${it.to}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={() => go(it)}
            >
              <span className={`chip ${it.kind === "page" ? "neutral" : it.kind === "stock" ? "buy" : "sell"}`}>{it.kind}</span>
              <span className={it.kind === "stock" ? "mono" : ""}>{it.label}</span>
              <span className="muted clip-text">{it.hint}</span>
            </li>
          ))}
          {items.length === 0 && <li className="muted">No matches</li>}
        </ul>
        <div className="palette-foot faint">↑↓ to move · Enter to open · Esc to close · Ctrl+K or / anywhere</div>
      </div>
    </div>
  );
}
