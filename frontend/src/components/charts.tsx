import { useState } from "react";
import type { SummaryRow } from "../api";
import { integer, pct } from "../format";

// Keep in sync with styles.css.
export const COLORS = {
  buy: "#26a69a",
  sell: "#ef5350",
  price: "#c9d1d9",
  grid: "#1f2632",
  muted: "#8b95a7",
  faint: "#5b6577",
  bg: "#0b0e14",
  accent: "#f5a524",
};

/** Weekly bars; positive up, negative down from a shared baseline. */
export function Sparkbars({ values, color, label }: { values: number[]; color: string | ((v: number) => string); label: string }) {
  const w = 300;
  const h = 36;
  const max = Math.max(...values.map(Math.abs), 1);
  const hasNeg = values.some((v) => v < 0);
  const base = hasNeg ? h / 2 : h;
  const scale = hasNeg ? h / 2 : h;
  const bw = w / Math.max(values.length, 1);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {values.map((v, i) => {
        const len = Math.max((Math.abs(v) / max) * scale, v === 0 ? 0 : 1);
        return (
          <rect
            key={i}
            x={i * bw + bw * 0.15}
            width={bw * 0.7}
            y={v >= 0 ? base - len : base}
            height={len}
            fill={typeof color === "function" ? color(v) : color}
            opacity={0.9}
          />
        );
      })}
      {hasNeg && <line x1={0} x2={w} y1={base} y2={base} stroke={COLORS.grid} strokeWidth={1} />}
    </svg>
  );
}

/** Mean return vs Nifty by holding period, one line per side. */
export function ExcessChart({ summary }: { summary: SummaryRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const horizons = [...new Set(summary.map((r) => r.horizon_days))].sort((a, b) => a - b);
  const sides = (["buy", "sell"] as const).filter((s) => summary.some((r) => r.direction === s && r.events > 0));
  const at = (side: string, h: number) => summary.find((r) => r.direction === side && r.horizon_days === h);
  const values = summary.map((r) => (r.mean_excess ?? 0) * 100);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const pad = (hi - lo || 1) * 0.12;
  const [y0, y1] = [lo - pad, hi + pad];

  const W = 640;
  const H = 260;
  const m = { l: 48, r: 16, t: 12, b: 34 };
  const x = (i: number) => m.l + ((W - m.l - m.r) * (i + 0.5)) / horizons.length;
  const y = (v: number) => m.t + ((y1 - v) / (y1 - y0)) * (H - m.t - m.b);
  const ticks = niceTicks(y0, y1, 5);

  return (
    <div style={{ position: "relative" }}>
      <div className="legend" style={{ marginBottom: 4 }}>
        {sides.map((s) => (
          <span key={s}>
            <span style={{ color: COLORS[s] }}>━</span> after promoter {s}s
          </span>
        ))}
        <span className="faint">avg return vs Nifty 50, by trading days held</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Average return versus Nifty by holding period">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={COLORS.grid} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" fill={COLORS.faint} fontSize={11} fontFamily="IBM Plex Mono">
              {t > 0 ? "+" : ""}
              {t}%
            </text>
          </g>
        ))}
        <line x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} stroke={COLORS.muted} strokeDasharray="3 3" />
        {horizons.map((h, i) => (
          <g key={h} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={x(i) - (W - m.l - m.r) / horizons.length / 2} y={m.t} width={(W - m.l - m.r) / horizons.length} height={H - m.t - m.b} fill={hover === i ? "rgba(255,255,255,0.03)" : "transparent"} />
            <text x={x(i)} y={H - 10} textAnchor="middle" fill={COLORS.muted} fontSize={11} fontFamily="IBM Plex Mono">
              +{h}d
            </text>
          </g>
        ))}
        {sides.map((side) => {
          const pts = horizons
            .map((h, i) => ({ i, v: at(side, h)?.mean_excess }))
            .filter((p): p is { i: number; v: number } => p.v != null);
          const color = COLORS[side];
          return (
            <g key={side} pointerEvents="none">
              <polyline fill="none" stroke={color} strokeWidth={2.2} points={pts.map((p) => `${x(p.i)},${y(p.v * 100)}`).join(" ")} />
              {pts.map((p) => (
                <circle key={p.i} cx={x(p.i)} cy={y(p.v * 100)} r={hover === p.i ? 5 : 3.5} fill={color} stroke={COLORS.bg} strokeWidth={1.5} />
              ))}
            </g>
          );
        })}
      </svg>
      {hover != null && horizons[hover] != null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)" }}>
          <div className="mono">Held +{horizons[hover]} trading days</div>
          {sides.map((side) => {
            const r = at(side, horizons[hover]!);
            return (
              <div className="row" key={side}>
                <span className={`chip ${side}`}>{side}</span>
                <span className={`mono ${side === "buy" ? "pos" : "neg"}`}>{pct(r?.mean_excess)}</span>
                <span className="muted">
                  beat Nifty {r?.hit_rate != null ? `${Math.round(r.hit_rate * 100)}%` : "–"} · n={integer(r?.events)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}
