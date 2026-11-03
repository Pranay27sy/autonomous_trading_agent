// Chart drawings: the data saved per stock (points are anchored to a time and a price),
// and the geometry that turns a drawing into pixels for the current view. Rendering
// (primitive.ts) and mouse hit testing (controller.ts) both work from the same shapes.
import { DAY } from "./timeIndex";

/** Keep in sync with DrawingType in promoter_tracker/api.py. */
export const DRAWING_TYPES = [
  "trend", "ray", "extended", "arrow", "hline", "hray", "vline", "rect", "channel", "fib", "measure", "text",
] as const;
export type DrawingType = (typeof DRAWING_TYPES)[number];
export type LineStyleName = "solid" | "dashed" | "dotted";

/** A point on the chart: a bar time (UTC seconds) and a price. */
export interface Anchor {
  time: number;
  price: number;
}

export interface DrawingStyle {
  color: string;
  /** Line width in pixels, or the font size step (1–4) for text. */
  width: number;
  style: LineStyleName;
}

export interface Drawing extends DrawingStyle {
  id: string;
  type: DrawingType;
  points: Anchor[];
  text?: string;
}

export interface ToolSpec {
  label: string;
  /** Clicks needed to place it. */
  points: number;
  /** KeyboardEvent.code that selects the tool together with Alt. */
  shortcut?: string;
  style: DrawingStyle;
}

const BLUE = "#42a5f5";
export const TOOLS: Record<DrawingType, ToolSpec> = {
  trend: { label: "Trend line", points: 2, shortcut: "KeyT", style: { color: BLUE, width: 2, style: "solid" } },
  ray: { label: "Ray", points: 2, shortcut: "KeyY", style: { color: BLUE, width: 2, style: "solid" } },
  extended: { label: "Extended line", points: 2, shortcut: "KeyE", style: { color: BLUE, width: 2, style: "solid" } },
  arrow: { label: "Arrow", points: 2, shortcut: "KeyA", style: { color: "#f5a524", width: 2, style: "solid" } },
  hline: { label: "Horizontal line", points: 1, shortcut: "KeyH", style: { color: BLUE, width: 1, style: "solid" } },
  hray: { label: "Horizontal ray", points: 1, shortcut: "KeyJ", style: { color: BLUE, width: 1, style: "solid" } },
  vline: { label: "Vertical line", points: 1, shortcut: "KeyV", style: { color: BLUE, width: 1, style: "solid" } },
  rect: { label: "Rectangle", points: 2, shortcut: "KeyB", style: { color: "#ab47bc", width: 1, style: "solid" } },
  channel: { label: "Parallel channel", points: 3, shortcut: "KeyC", style: { color: BLUE, width: 1, style: "solid" } },
  fib: { label: "Fib retracement", points: 2, shortcut: "KeyF", style: { color: "#8b95a7", width: 1, style: "dashed" } },
  measure: { label: "Measure", points: 2, shortcut: "KeyM", style: { color: BLUE, width: 1, style: "solid" } },
  text: { label: "Text note", points: 1, shortcut: "KeyN", style: { color: "#e6e9ef", width: 2, style: "solid" } },
};

export const PALETTE = ["#42a5f5", "#f5a524", "#26a69a", "#ef5350", "#ab47bc", "#ffee58", "#e6e9ef", "#8b95a7"];
/** Retracement levels: 0 at the second point, 1 at the first (as on most charting tools). */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#8b95a7", "#ef5350", "#ff9800", "#4caf50", "#26a69a", "#00bcd4", "#8b95a7"];
export const TEXT_SIZES = [12, 14, 18, 24];
export const LINE_HEIGHT = 1.3;

export interface P {
  x: number;
  y: number;
}

/** Converts between chart values and pane pixels: the chart in engine.ts, a stub in tests. */
export interface Viewport {
  /** Pane size in CSS pixels. */
  width: number;
  height: number;
  /** Logical bar index of a time and back (see TimeIndex). */
  logical(time: number): number;
  timeAt(logical: number): number;
  /** Pixel x of a logical index, and the (fractional) logical index at a pixel x. */
  xAt(logical: number): number;
  logicalAt(x: number): number;
  /** Pixel y of a price, and the price at a pixel y. */
  y(price: number): number;
  price(y: number): number;
  /** The candle at a logical index, for the magnet. */
  bar(logical: number): { open: number; high: number; low: number; close: number } | undefined;
  formatPrice(price: number): string;
  measureText(text: string, size: number, font: "sans" | "mono"): number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Mark =
  | { kind: "line"; a: P; b: P; color: string; width: number; style: LineStyleName }
  | { kind: "fill"; pts: P[]; color: string }
  | { kind: "arrowhead"; tip: P; from: P; color: string; size: number }
  | {
      kind: "text";
      box: Box;
      lines: string[];
      widths: number[];
      color: string;
      size: number;
      font: "sans" | "mono";
      align: "left" | "center";
      pad: number;
      bg?: string;
    };

export interface Shape {
  marks: Mark[];
  /** Drag handles, in the order moveHandle numbers them. */
  handles: P[];
  /** Filled areas and text boxes that count as hitting the drawing. */
  areas: P[][];
  /** Drawn dashed around a selected text note. */
  outline?: Box;
}

const EMPTY: Shape = { marks: [], handles: [], areas: [] };
/** Lines that run off the pane are extended this far past its edges. */
const OVERSHOOT = 50;

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Black or white, whichever reads better on a background color. */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#0b0e14" : "#ffffff";
}

let seq = 0;
export function newId(): string {
  seq += 1;
  return `d${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newDrawing(type: DrawingType, at: Anchor, style: DrawingStyle): Drawing {
  const points = Array.from({ length: TOOLS[type].points }, () => ({ ...at }));
  return { id: newId(), type, points, ...style, ...(type === "text" ? { text: "" } : {}) };
}

/** Drawings loaded from the server or an old version, minus anything malformed. */
export function sanitize(list: unknown): Drawing[] {
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is Drawing => {
    if (!d || typeof d !== "object") return false;
    const x = d as Drawing;
    return (
      (DRAWING_TYPES as readonly string[]).includes(x.type) &&
      typeof x.id === "string" &&
      Array.isArray(x.points) &&
      x.points.length === TOOLS[x.type].points &&
      x.points.every((p) => Number.isFinite(p?.time) && Number.isFinite(p?.price)) &&
      (x.type !== "text" || !!x.text?.trim())
    );
  });
}

// --- geometry ------------------------------------------------------------------------

export function distToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function inPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Where the ray from a through b leaves the pane (plus an overshoot); b itself if that's farther. */
export function rayEnd(a: P, b: P, w: number, h: number): P {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return b;
  const tx = dx > 0 ? (w + OVERSHOOT - a.x) / dx : dx < 0 ? (-OVERSHOOT - a.x) / dx : Infinity;
  const ty = dy > 0 ? (h + OVERSHOOT - a.y) / dy : dy < 0 ? (-OVERSHOOT - a.y) / dy : Infinity;
  const t = Math.max(Math.min(tx, ty), 1);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

const rectPts = (b: Box): P[] => [
  { x: b.x, y: b.y },
  { x: b.x + b.w, y: b.y },
  { x: b.x + b.w, y: b.y + b.h },
  { x: b.x, y: b.y + b.h },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function textMark(
  vp: Viewport,
  lines: string[],
  at: P,
  opts: { size: number; font: "sans" | "mono"; color: string; align: "left" | "center"; anchor: "middle-left" | "above" | "below" | "bottom-left"; bg?: string },
): Extract<Mark, { kind: "text" }> {
  const pad = opts.bg ? 6 : 0;
  const widths = lines.map((l) => vp.measureText(l, opts.size, opts.font));
  const w = Math.max(0, ...widths) + 2 * pad;
  const h = lines.length * opts.size * LINE_HEIGHT + 2 * pad;
  const x = opts.align === "center" ? at.x - w / 2 : at.x;
  const y =
    opts.anchor === "middle-left" ? at.y - h / 2 : opts.anchor === "above" || opts.anchor === "bottom-left" ? at.y - h : at.y;
  return { kind: "text", box: { x, y, w, h }, lines, widths, color: opts.color, size: opts.size, font: opts.font, align: opts.align, pad, bg: opts.bg };
}

/** Pixel position of an anchor in the current view. */
export function toPixel(vp: Viewport, a: Anchor): P {
  return { x: vp.xAt(vp.logical(a.time)), y: vp.y(a.price) };
}

/** The lines, fills, labels and handles that draw `d` in the current view. */
export function shapeOf(d: Drawing, vp: Viewport): Shape {
  const W = vp.width;
  const H = vp.height;
  const pts = d.points.map((a) => toPixel(vp, a));
  // Off-screen points are fine; points the chart can't place (no data yet) aren't.
  if (!pts.length || !pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return EMPTY;
  const p1 = pts[0]!;
  const p2 = pts[1] ?? p1;
  const line = (a: P, b: P, patch: Partial<Extract<Mark, { kind: "line" }>> = {}): Mark => ({
    kind: "line", a, b, color: d.color, width: d.width, style: d.style, ...patch,
  });

  switch (d.type) {
    case "trend":
      return { marks: [line(p1, p2)], handles: [p1, p2], areas: [] };
    case "ray":
      return { marks: [line(p1, rayEnd(p1, p2, W, H))], handles: [p1, p2], areas: [] };
    case "extended":
      return { marks: [line(rayEnd(p2, p1, W, H), rayEnd(p1, p2, W, H))], handles: [p1, p2], areas: [] };
    case "arrow":
      return {
        marks: [line(p1, p2), { kind: "arrowhead", tip: p2, from: p1, color: d.color, size: 7 + 2 * d.width }],
        handles: [p1, p2],
        areas: [],
      };
    case "hline":
      return {
        marks: [line({ x: -OVERSHOOT, y: p1.y }, { x: W + OVERSHOOT, y: p1.y })],
        handles: [{ x: p1.x >= 12 && p1.x <= W - 12 ? p1.x : W / 2, y: p1.y }],
        areas: [],
      };
    case "hray":
      return { marks: [line(p1, { x: Math.max(W, p1.x) + OVERSHOOT, y: p1.y })], handles: [p1], areas: [] };
    case "vline":
      return {
        marks: [line({ x: p1.x, y: -OVERSHOOT }, { x: p1.x, y: H + OVERSHOOT })],
        handles: [{ x: p1.x, y: p1.y >= 12 && p1.y <= H - 12 ? p1.y : H / 2 }],
        areas: [],
      };
    case "rect": {
      const corners = [p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }];
      return {
        marks: [
          { kind: "fill", pts: corners, color: withAlpha(d.color, 0.15) },
          ...corners.map((c, i) => line(c, corners[(i + 1) % 4]!)),
        ],
        handles: corners,
        areas: [corners],
      };
    }
    case "channel": {
      const off = (pts[2] ?? p1).y - p1.y;
      const q1 = { x: p1.x, y: p1.y + off };
      const q2 = { x: p2.x, y: p2.y + off };
      const half = (p: P) => ({ x: p.x, y: p.y + off / 2 });
      const area = [p1, p2, q2, q1];
      return {
        marks: [
          { kind: "fill", pts: area, color: withAlpha(d.color, 0.12) },
          line(p1, p2),
          line(q1, q2),
          line(half(p1), half(p2), { width: 1, style: "dashed" }),
        ],
        handles: [p1, p2, q1, q2],
        areas: [area],
      };
    }
    case "fib": {
      const [a, b = a] = d.points as [Anchor, Anchor?];
      const left = Math.min(p1.x, p2.x);
      const right = Math.max(p1.x, p2.x, left + 1);
      const levels = FIB_LEVELS.map((lv, i) => {
        const price = b.price + (a.price - b.price) * lv;
        return { lv, price, y: vp.y(price), color: FIB_COLORS[i]! };
      });
      const marks: Mark[] = [];
      levels.slice(1).forEach((l, i) => {
        const prev = levels[i]!;
        marks.push({
          kind: "fill",
          pts: [{ x: left, y: prev.y }, { x: right, y: prev.y }, { x: right, y: l.y }, { x: left, y: l.y }],
          color: withAlpha(l.color, 0.08),
        });
      });
      for (const l of levels) {
        marks.push(line({ x: left, y: l.y }, { x: right, y: l.y }, { color: l.color, width: 1, style: "solid" }));
        marks.push(
          textMark(vp, [`${l.lv} (${vp.formatPrice(l.price)})`], { x: left + 4, y: l.y - 2 }, {
            size: 11, font: "mono", color: l.color, align: "left", anchor: "bottom-left",
          }),
        );
      }
      marks.push(line(p1, p2));
      const ys = levels.map((l) => l.y);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      return {
        marks,
        handles: [p1, p2],
        areas: [[{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]],
      };
    }
    case "measure": {
      const [a, b = a] = d.points as [Anchor, Anchor?];
      const up = b.price >= a.price;
      const color = up ? "#42a5f5" : "#ef5350";
      const corners = [p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }];
      const change = b.price - a.price;
      const pct = a.price ? change / a.price : 0;
      const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
      const bars = Math.round(vp.logical(b.time) - vp.logical(a.time));
      const days = Math.round((b.time - a.time) / DAY);
      const label = textMark(
        vp,
        [
          `${sign(change)}${vp.formatPrice(Math.abs(change))} (${sign(pct)}${Math.abs(pct * 100).toFixed(2)}%)`,
          `${bars} bar${Math.abs(bars) === 1 ? "" : "s"}, ${days}d`,
        ],
        { x: (p1.x + p2.x) / 2, y: up ? Math.min(p1.y, p2.y) - 8 : Math.max(p1.y, p2.y) + 8 },
        { size: 12, font: "mono", color: "#ffffff", align: "center", anchor: up ? "above" : "below", bg: withAlpha(color, 0.9) },
      );
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const marks: Mark[] = [{ kind: "fill", pts: corners, color: withAlpha(color, 0.16) }];
      if (Math.abs(p2.y - p1.y) > 6) {
        marks.push(line({ x: midX, y: p1.y }, { x: midX, y: p2.y }, { color, width: 1, style: "solid" }));
        marks.push({ kind: "arrowhead", tip: { x: midX, y: p2.y }, from: { x: midX, y: p1.y }, color, size: 7 });
      }
      if (Math.abs(p2.x - p1.x) > 6) {
        marks.push(line({ x: p1.x, y: midY }, { x: p2.x, y: midY }, { color, width: 1, style: "solid" }));
        marks.push({ kind: "arrowhead", tip: { x: p2.x, y: midY }, from: { x: p1.x, y: midY }, color, size: 7 });
      }
      marks.push(label);
      return { marks, handles: [p1, p2], areas: [corners, rectPts(label.box)] };
    }
    case "text": {
      const text = (d.text ?? "").trim();
      if (!text) return EMPTY;
      const mark = textMark(vp, text.split("\n"), p1, {
        size: TEXT_SIZES[clamp(d.width, 1, 4) - 1]!, font: "sans", color: d.color, align: "left", anchor: "middle-left",
      });
      const outline = { x: mark.box.x - 4, y: mark.box.y - 3, w: mark.box.w + 8, h: mark.box.h + 6 };
      return { marks: [mark], handles: [], areas: [rectPts(outline)], outline };
    }
  }
}

/** Index of the handle within `r` pixels of p, or -1. */
export function hitHandle(s: Shape, p: P, r = 8): number {
  let best = -1;
  let bestDist = r;
  s.handles.forEach((h, i) => {
    const dist = Math.hypot(h.x - p.x, h.y - p.y);
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  return best;
}

/** True if p is on one of the shape's lines (within `tol` pixels) or inside one of its areas. */
export function hitShape(s: Shape, p: P, tol = 5): boolean {
  for (const m of s.marks) {
    if (m.kind === "line" && distToSegment(p, m.a, m.b) <= tol + m.width / 2) return true;
  }
  return s.areas.some((a) => inPolygon(p, a));
}

// --- editing ---------------------------------------------------------------------------

/** x of an anchor and y of a price, for edits that work in pixels. */
const xOf = (vp: Viewport, a: Anchor) => vp.xAt(vp.logical(a.time));

/** `d` with drag handle k (see shapeOf) moved to anchor `a`. */
export function moveHandle(d: Drawing, k: number, a: Anchor, vp: Viewport): Drawing {
  const pts = d.points.map((p) => ({ ...p }));
  if (d.type === "rect") {
    const [p1, p2] = pts as [Anchor, Anchor];
    if (k === 0) pts[0] = { ...a };
    else if (k === 2) pts[1] = { ...a };
    else if (k === 1) {
      p2.time = a.time;
      p1.price = a.price;
    } else {
      p1.time = a.time;
      p2.price = a.price;
    }
  } else if (d.type === "channel") {
    // The third point holds the parallel line's offset, at the first point's time.
    const [p1, p2, p3] = pts as [Anchor, Anchor, Anchor];
    if (k === 0) {
      const off = vp.y(p3.price) - vp.y(p1.price);
      pts[0] = { ...a };
      pts[2] = { time: a.time, price: vp.price(vp.y(a.price) + off) };
    } else if (k === 1) {
      pts[1] = { ...a };
    } else {
      const base = k === 2 ? p1 : p2;
      const off = vp.y(a.price) - vp.y(base.price);
      pts[2] = { time: p1.time, price: vp.price(vp.y(p1.price) + off) };
    }
  } else if (k < pts.length) {
    pts[k] = { ...a };
  }
  return { ...d, points: pts };
}

/** `d` moved by whole bars and by dy pixels, so it keeps its shape on any price scale. */
export function moveBy(d: Drawing, bars: number, dy: number, vp: Viewport): Drawing {
  return {
    ...d,
    points: d.points.map((p) => ({
      time: vp.timeAt(Math.round(vp.logical(p.time)) + bars),
      price: vp.price(vp.y(p.price) + dy),
    })),
  };
}

/** A drawing being placed: the first `placed` points are fixed and the next follows the pointer. */
export function placing(d: Drawing, placed: number, a: Anchor, vp: Viewport): Drawing {
  const pts = d.points.map((p) => ({ ...p }));
  if (d.type === "channel" && placed === 2) {
    // Third click: the parallel line runs through the pointer.
    const [p1, p2] = pts as [Anchor, Anchor];
    const [x1, x2, x] = [xOf(vp, p1), xOf(vp, p2), xOf(vp, a)];
    const [y1, y2] = [vp.y(p1.price), vp.y(p2.price)];
    const onBase = x2 === x1 ? y1 : y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
    pts[2] = { time: p1.time, price: vp.price(y1 + vp.y(a.price) - onBase) };
  } else {
    for (let i = placed; i < pts.length; i++) pts[i] = { ...a };
    if (d.type === "channel") pts[2] = { ...pts[0]! };
  }
  return { ...d, points: pts };
}
