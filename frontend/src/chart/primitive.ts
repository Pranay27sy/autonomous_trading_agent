// Draws the chart's drawings on the price pane as a Lightweight Charts series primitive,
// with their prices and dates on the axes and hover cursors.
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { DrawingController, RenderItem } from "./controller";
import { LINE_HEIGHT, inkOn, type LineStyleName, type Mark, type P, type Shape, type Viewport } from "./drawings";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export const FONTS = {
  sans: '"IBM Plex Sans", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

function axisLabel(coordinate: number, text: string, color: string): ISeriesPrimitiveAxisView {
  return {
    coordinate: () => coordinate,
    text: () => text,
    textColor: () => inkOn(color),
    backColor: () => color,
    visible: () => Number.isFinite(coordinate),
  };
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private items: RenderItem[] = [];
  private zoomBox: { a: P; b: P } | null = null;
  private priceLabels: ISeriesPrimitiveAxisView[] = [];
  private timeLabels: ISeriesPrimitiveAxisView[] = [];
  private readonly views: readonly IPrimitivePaneView[];
  private requestUpdate: (() => void) | null = null;

  constructor(
    private ctl: DrawingController,
    private viewport: () => Viewport | null,
    private formatTime: (time: number) => string,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  /** Redraw after the drawings changed. */
  update(): void {
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    const vp = this.viewport();
    this.items = vp ? this.ctl.renderList(vp) : [];
    this.zoomBox = this.ctl.zoomBox;
    const prices: ISeriesPrimitiveAxisView[] = [];
    const times: ISeriesPrimitiveAxisView[] = [];
    if (vp) {
      for (const { drawing: d, state } of this.items) {
        const active = state === "selected" || state === "draft";
        // Horizontal levels always show their price, vertical lines their date;
        // the selected drawing shows both for every point.
        if (d.type === "hline" || d.type === "hray" || (active && d.type !== "vline" && d.type !== "text")) {
          for (const p of d.points) prices.push(axisLabel(vp.y(p.price), vp.formatPrice(p.price), d.color));
        }
        if (d.type === "vline" || (active && d.type !== "hline" && d.type !== "text")) {
          for (const p of d.type === "channel" ? d.points.slice(0, 2) : d.points) {
            times.push(axisLabel(vp.xAt(vp.logical(p.time)), this.formatTime(p.time), d.color));
          }
        }
      }
    }
    this.priceLabels = prices;
    this.timeLabels = times;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.priceLabels;
  }

  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.timeLabels;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const hit = this.ctl.hitAt({ x, y });
    if (!hit) return null;
    return { externalId: hit.id, zOrder: "top", cursorStyle: hit.handle >= 0 ? "move" : "pointer", itemType: "primitive" };
  }

  private draw(target: Target): void {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (const it of this.items) {
        drawShape(ctx, it.shape, hr, vr);
        if (it.state === "normal") continue;
        if (it.shape.outline && it.state === "selected") drawOutline(ctx, it.shape, it.drawing.color, hr, vr);
        drawHandles(ctx, it.shape.handles, it.drawing.color, hr, vr, it.state === "hovered" ? 0.55 : 1);
      }
      const z = this.zoomBox;
      if (z) {
        const x = Math.min(z.a.x, z.b.x) * hr;
        const y = Math.min(z.a.y, z.b.y) * vr;
        const w = Math.abs(z.b.x - z.a.x) * hr;
        const h = Math.abs(z.b.y - z.a.y) * vr;
        ctx.fillStyle = "rgba(66, 165, 245, 0.12)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#42a5f5";
        ctx.lineWidth = Math.max(1, Math.round(hr));
        ctx.setLineDash([4 * hr, 3 * hr]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      }
    });
  }
}

function dash(style: LineStyleName, ratio: number): number[] {
  if (style === "dashed") return [6 * ratio, 4 * ratio];
  if (style === "dotted") return [1.5 * ratio, 3 * ratio];
  return [];
}

/** Paint one drawing's marks onto the pane (bitmap pixels = CSS pixels × ratio). */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, hr: number, vr: number): void {
  for (const m of shape.marks) drawMark(ctx, m, hr, vr);
}

function drawMark(ctx: CanvasRenderingContext2D, m: Mark, hr: number, vr: number): void {
  switch (m.kind) {
    case "fill": {
      ctx.fillStyle = m.color;
      ctx.beginPath();
      m.pts.forEach((p, i) => (i ? ctx.lineTo(p.x * hr, p.y * vr) : ctx.moveTo(p.x * hr, p.y * vr)));
      ctx.closePath();
      ctx.fill();
      return;
    }
    case "line": {
      const lw = Math.max(1, Math.round(m.width * hr));
      let [ax, ay, bx, by] = [m.a.x * hr, m.a.y * vr, m.b.x * hr, m.b.y * vr];
      // Keep horizontal and vertical lines crisp on the pixel grid.
      const half = lw % 2 ? 0.5 : 0;
      if (Math.abs(ay - by) < 0.01) ay = by = Math.round(ay) + half;
      if (Math.abs(ax - bx) < 0.01) ax = bx = Math.round(ax) + half;
      ctx.lineWidth = lw;
      ctx.strokeStyle = m.color;
      ctx.lineCap = m.style === "dotted" ? "round" : "butt";
      ctx.setLineDash(dash(m.style, hr));
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    case "arrowhead": {
      const angle = Math.atan2(m.tip.y - m.from.y, m.tip.x - m.from.x);
      if (m.tip.x === m.from.x && m.tip.y === m.from.y) return;
      const wing = (side: number) => ({
        x: (m.tip.x - m.size * Math.cos(angle + side * 0.42)) * hr,
        y: (m.tip.y - m.size * Math.sin(angle + side * 0.42)) * vr,
      });
      const [l, r] = [wing(-1), wing(1)];
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(m.tip.x * hr, m.tip.y * vr);
      ctx.lineTo(l.x, l.y);
      ctx.lineTo(r.x, r.y);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case "text": {
      const { box } = m;
      if (m.bg) {
        ctx.fillStyle = m.bg;
        ctx.beginPath();
        ctx.roundRect(box.x * hr, box.y * vr, box.w * hr, box.h * vr, 3 * hr);
        ctx.fill();
      }
      ctx.font = `${m.size * vr}px ${FONTS[m.font]}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = m.color;
      m.lines.forEach((line, i) => {
        const x = m.align === "center" ? box.x + (box.w - (m.widths[i] ?? 0)) / 2 : box.x + m.pad;
        const y = box.y + m.pad + (i + 0.5) * m.size * LINE_HEIGHT;
        ctx.fillText(line, x * hr, y * vr);
      });
      return;
    }
  }
}

function drawHandles(ctx: CanvasRenderingContext2D, handles: P[], color: string, hr: number, vr: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(1, 1.5 * hr);
  for (const h of handles) {
    ctx.beginPath();
    ctx.arc(h.x * hr, h.y * vr, 4.5 * hr, 0, 2 * Math.PI);
    ctx.fillStyle = "#0b0e14";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawOutline(ctx: CanvasRenderingContext2D, shape: Shape, color: string, hr: number, vr: number): void {
  const b = shape.outline!;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(hr));
  ctx.setLineDash([4 * hr, 3 * hr]);
  ctx.strokeRect(b.x * hr, b.y * vr, b.w * hr, b.h * vr);
  ctx.setLineDash([]);
}
