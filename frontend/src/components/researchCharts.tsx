import { ColorType, createChart, LineSeries, type Time } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { pct } from "../format";
import { COLORS, niceTicks } from "./charts";

/** Strategy vs Nifty growth of ₹1, as two lines. */
export function EquityChart({ points }: { points: { time: string; strategy: number; benchmark: number }[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.muted,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.grid },
      timeScale: { borderColor: COLORS.grid },
      localization: { priceFormatter: (p: number) => pct(p - 1) },
    });
    const strat = chart.addSeries(LineSeries, { color: COLORS.accent, lineWidth: 2, title: "Strategy" });
    const bench = chart.addSeries(LineSeries, { color: COLORS.muted, lineWidth: 2, title: "Nifty 50" });
    strat.setData(points.map((p) => ({ time: p.time as Time, value: p.strategy })));
    bench.setData(points.map((p) => ({ time: p.time as Time, value: p.benchmark })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return <div className="chart-box" style={{ height: 340 }} ref={box} role="img" aria-label="Strategy vs Nifty equity curve" />;
}

export interface StudyGroup {
  group: string;
  events: number;
  points: { day: number; mean: number | null; lo: number | null; hi: number | null; n: number }[];
}

// Groups without a fixed colour (e.g. pattern names) take the next from this palette.
const PALETTE = ["#f5a524", "#42a5f5", "#ab47bc", "#26a69a", "#ef5350", "#e6e9ef", "#8b95a7"];
const groupColor = (name: string, i: number) => GROUP_COLORS[name] ?? PALETTE[i % PALETTE.length]!;

const GROUP_COLORS: Record<string, string> = {
  "Promoters buying during the pattern": COLORS.buy,
  "No promoter buying": COLORS.muted,
  "Promoter buys": COLORS.buy,
  "Promoter sells": COLORS.sell,
  "High (60+)": COLORS.buy,
  "Medium (35–59)": COLORS.accent,
  "Low (0–34)": COLORS.muted,
};

/** Average cumulative excess return by day around the event, with 95% bands. */
export function EventStudyChart({ groups, before, after }: { groups: StudyGroup[]; before: number; after: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = 320;
  const m = { l: 52, r: 16, t: 12, b: 30 };
  const vals = groups.flatMap((g) => g.points.flatMap((p) => [p.lo ?? 0, p.hi ?? 0]));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const pad = (hi - lo || 0.01) * 0.08;
  const [y0, y1] = [lo - pad, hi + pad];
  const x = (d: number) => m.l + ((d + before) / (before + after)) * (W - m.l - m.r);
  const y = (v: number) => m.t + ((y1 - v) / (y1 - y0)) * (H - m.t - m.b);
  // Ticks in whole percentage points (the series are fractions).
  const ticks = niceTicks(y0 * 100, y1 * 100, 6).map((t) => t / 100);
  const xticks = [-before, 0, 20, 40, 60, 80, 100, 120].filter((d) => d >= -before && d <= after);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const d = Math.round(((px - m.l) / (W - m.l - m.r)) * (before + after) - before);
    setHover(d >= -before && d <= after ? d : null);
  };

  return (
    <div style={{ position: "relative" }}>
      <div className="legend" style={{ marginBottom: 6, flexWrap: "wrap" }}>
        {groups.map((g, i) => (
          <span key={g.group}>
            <span style={{ color: groupColor(g.group, i) }}>━</span> {g.group} <span className="faint">({g.events.toLocaleString("en-IN")})</span>
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Event study" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={COLORS.grid} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" fill={COLORS.faint} fontSize={11} fontFamily="IBM Plex Mono">
              {pct(t, 0)}
            </text>
          </g>
        ))}
        {xticks.map((d) => (
          <text key={d} x={x(d)} y={H - 10} textAnchor="middle" fill={COLORS.muted} fontSize={11} fontFamily="IBM Plex Mono">
            {d > 0 ? `+${d}` : d}
          </text>
        ))}
        <line x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} stroke={COLORS.muted} strokeDasharray="3 3" />
        <line x1={x(0)} x2={x(0)} y1={m.t} y2={H - m.b} stroke={COLORS.muted} strokeDasharray="3 3" />
        {groups.map((g) => {
          const pts = g.points.filter((p) => p.mean != null);
          const color = groupColor(g.group, groups.indexOf(g));
          const band =
            pts.map((p) => `${x(p.day)},${y(p.hi ?? p.mean!)}`).join(" ") +
            " " +
            [...pts].reverse().map((p) => `${x(p.day)},${y(p.lo ?? p.mean!)}`).join(" ");
          return (
            <g key={g.group}>
              <polygon points={band} fill={color} opacity={0.12} />
              <polyline fill="none" stroke={color} strokeWidth={2} points={pts.map((p) => `${x(p.day)},${y(p.mean!)}`).join(" ")} />
            </g>
          );
        })}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} stroke={COLORS.faint} />}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${Math.min(70, (x(hover) / W) * 100)}%` }}>
          <div className="mono">Day {hover > 0 ? `+${hover}` : hover} (trading days from entry)</div>
          {groups.map((g) => {
            const p = g.points.find((q) => q.day === hover);
            return (
              <div className="row" key={g.group}>
                <span style={{ color: groupColor(g.group, groups.indexOf(g)) }}>━</span>
                <span>{g.group}</span>
                <span className="mono">{pct(p?.mean)}</span>
                <span className="muted mono">
                  [{pct(p?.lo)}, {pct(p?.hi)}] n={p?.n ?? 0}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
