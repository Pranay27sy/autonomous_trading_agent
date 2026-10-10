import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, type Side } from "../api";

export function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  format?: (value: T) => string;
}) {
  const { label, options, value, onChange, format = String } = props;
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o)} type="button" aria-pressed={o === value} onClick={() => onChange(o)}>
          {format(o)}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="switch" title={props.title}>
      <input type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function SideChip({ side }: { side: Side }) {
  return <span className={`chip ${side}`}>{side}</span>;
}

export function Card(props: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${props.className ?? ""}`}>
      {(props.title || props.actions) && (
        <div className="card-head">
          {typeof props.title === "string" ? <h2>{props.title}</h2> : props.title}
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function Empty(props: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="card error" role="alert">
      Couldn't load this view: {msg}
    </div>
  );
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden="true" />;
}

/** Link to a stock's page that keeps the current filters. */
export function StockLink({ symbol }: { symbol: string }) {
  const { search } = useLocation();
  return (
    <Link className="btn-link" to={{ pathname: `/stock/${encodeURIComponent(symbol)}`, search }}>
      {symbol}
    </Link>
  );
}
