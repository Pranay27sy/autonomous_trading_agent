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

/** Conviction score with a bar; the reasons show on hover. */
export function ConvictionBadge({ score, reasons }: { score: number | null; reasons?: string[] }) {
  if (score == null) return <span className="faint">–</span>;
  const tier = score >= 60 ? "hi" : score >= 35 ? "mid" : "lo";
  const why = reasons?.length ? `Conviction ${score}/100:\n• ${reasons.join("\n• ")}` : `Conviction ${score}/100`;
  return (
    <span className={`conviction ${tier}`} title={why} aria-label={why}>
      <span className="conviction-bar">
        <span style={{ width: `${score}%` }} />
      </span>
      <span className="mono">{score}</span>
    </span>
  );
}

/** 0–100 score with a bar (same look as conviction); the reasons show on hover. */
export function QualityBadge({ score, reasons }: { score: number | null; reasons?: string[] }) {
  if (score == null) return <span className="faint">–</span>;
  const tier = score >= 70 ? "hi" : score >= 50 ? "mid" : "lo";
  const why = reasons?.length ? `Quality ${score}/100:\n• ${reasons.join("\n• ")}` : `Quality ${score}/100`;
  return (
    <span className={`conviction ${tier}`} title={why} aria-label={why}>
      <span className="conviction-bar">
        <span style={{ width: `${score}%` }} />
      </span>
      <span className="mono">{score}</span>
    </span>
  );
}

const STATUS = {
  forming: ["forming", "neutral", "Shape complete; waiting for a breakout"],
  active: ["active", "neutral", "Broke out; neither target nor invalidation reached yet"],
  target_hit: ["target hit", "buy", "Reached the textbook target before failing"],
  failed: ["failed", "sell", "Price went back past the invalidation level first"],
  expired: ["expired", "neutral", "Neither target nor invalidation within a year"],
} as const;

export function StatusChip({ status }: { status: keyof typeof STATUS }) {
  const [label, tone, title] = STATUS[status];
  return (
    <span className={`chip ${tone}`} title={title}>
      {label}
    </span>
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

/** Toggle chips for picking several options. */
export function Chips({ options, selected, onChange }: { options: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            className={`chip-toggle ${on ? "on" : ""}`}
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((s) => s !== o) : [...selected, o])}
          >
            {o}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button type="button" className="btn-link faint" onClick={() => onChange([])}>
          clear
        </button>
      )}
    </div>
  );
}
