import { describe, expect, it, vi } from "vitest";
import { DrawingController, type ControllerHost } from "../chart/controller";
import {
  distToSegment,
  hitShape,
  moveBy,
  moveHandle,
  rayEnd,
  sanitize,
  shapeOf,
  type Drawing,
  type Mark,
  type Viewport,
} from "../chart/drawings";
import { DAY } from "../chart/timeIndex";

const T0 = 1_704_067_200; // 2024-01-01

/** 10 px per bar and one bar per day; y = 500 − 2 × price, so price 100 sits at y 300. */
function fakeViewport(): Viewport {
  return {
    width: 800,
    height: 500,
    logical: (t) => (t - T0) / DAY,
    timeAt: (l) => T0 + Math.round(l) * DAY,
    xAt: (l) => l * 10,
    logicalAt: (x) => x / 10,
    y: (p) => 500 - 2 * p,
    price: (y) => (500 - y) / 2,
    bar: (l) => (l >= 0 && l < 100 ? { open: 100, high: 110, low: 90, close: 105 } : undefined),
    formatPrice: (p) => p.toFixed(2),
    measureText: (text, size) => text.length * size * 0.6,
  };
}

const at = (bar: number, price: number) => ({ time: T0 + bar * DAY, price });
const style = { color: "#42a5f5", width: 2, style: "solid" as const };
const trend: Drawing = { id: "t", type: "trend", points: [at(10, 100), at(20, 120)], ...style };
const hline: Drawing = { id: "h", type: "hline", points: [at(5, 100)], ...style, width: 1 };
const texts = (marks: Mark[]) =>
  marks.filter((m): m is Extract<Mark, { kind: "text" }> => m.kind === "text").map((m) => m.lines.join(" | "));

describe("drawing geometry", () => {
  const vp = fakeViewport();

  it("measures distances and extends rays past the pane's edge", () => {
    expect(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    expect(rayEnd({ x: 0, y: 0 }, { x: 10, y: 10 }, 100, 1000)).toEqual({ x: 150, y: 150 });
  });

  it("hits lines within a few pixels and filled shapes anywhere inside", () => {
    const s = shapeOf(trend, vp); // (100, 300) to (200, 260)
    expect(hitShape(s, { x: 150, y: 281 })).toBe(true);
    expect(hitShape(s, { x: 150, y: 300 })).toBe(false);
    expect(hitShape(shapeOf({ ...trend, type: "rect" }, vp), { x: 150, y: 290 })).toBe(true);
    expect(hitShape(shapeOf(hline, vp), { x: 700, y: 303 })).toBe(true); // spans the whole pane
  });

  it("labels fib levels from 1 at the first point to 0 at the second", () => {
    const fib: Drawing = { ...trend, type: "fib", points: [at(0, 100), at(10, 200)] };
    const labels = texts(shapeOf(fib, vp).marks);
    expect(labels).toContain("0 (200.00)");
    expect(labels).toContain("0.618 (138.20)");
    expect(labels).toContain("1 (100.00)");
  });

  it("measures the change, bars and days between two points", () => {
    const m: Drawing = { ...trend, type: "measure", points: [at(0, 100), at(10, 110)] };
    expect(texts(shapeOf(m, vp).marks)).toEqual(["+10.00 (+10.00%) | 10 bars, 10d"]);
    const down: Drawing = { ...m, points: [at(0, 100), at(1, 95)] };
    expect(texts(shapeOf(down, vp).marks)).toEqual(["−5.00 (−5.00%) | 1 bar, 1d"]);
  });

  it("keeps a channel's second line parallel, through the third point", () => {
    const ch: Drawing = { ...trend, type: "channel", points: [at(0, 100), at(10, 120), at(0, 110)] };
    const { handles } = shapeOf(ch, vp);
    expect(handles[2]).toEqual({ x: 0, y: 280 });
    expect(handles[3]).toEqual({ x: 100, y: 240 });
  });

  it("moves drawings by whole bars and reshapes them by their handles", () => {
    expect(moveBy(trend, 3, -20, vp).points).toEqual([at(13, 110), at(23, 130)]);
    const rect: Drawing = { ...trend, type: "rect", points: [at(0, 100), at(10, 120)] };
    expect(moveHandle(rect, 1, at(12, 90), vp).points).toEqual([at(0, 90), at(12, 120)]);
  });

  it("drops malformed drawings when loading", () => {
    const list = [{ id: "x", type: "spiral", points: [] }, hline, { ...hline, id: "n", type: "text", text: " " }];
    expect(sanitize(list).map((d) => d.id)).toEqual(["h"]);
    expect(sanitize("nope")).toEqual([]);
  });
});

function setup() {
  const vp = fakeViewport();
  const changed: Drawing[][] = [];
  const host = {
    viewport: () => vp,
    repaint: () => {},
    changed: (d: Drawing[]) => changed.push(d),
    stateChanged: () => {},
    editText: vi.fn(),
    zoomTo: vi.fn(),
  } satisfies ControllerHost;
  return { ctl: new DrawingController(host), changed, host };
}

const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: code,
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

describe("drawing controller", () => {
  it("places a trend line with two clicks, snapped to bars", () => {
    const { ctl, changed } = setup();
    ctl.setTool("trend");
    expect(ctl.down({ x: 101, y: 300 })).toBe(true);
    ctl.up({ x: 101, y: 300 });
    ctl.move({ x: 199, y: 260 }, false);
    expect(ctl.draft?.drawing.points[1]).toEqual(at(20, 120)); // previews the second point
    ctl.down({ x: 199, y: 260 });
    ctl.up({ x: 199, y: 260 });
    expect(ctl.drawings.map((d) => d.points)).toEqual([[at(10, 100), at(20, 120)]]);
    expect(ctl.tool).toBe("cursor");
    expect(ctl.selected).toBe(ctl.drawings[0]!.id);
    expect(changed).toHaveLength(1);
  });

  it("also places one by pressing, dragging and releasing", () => {
    const { ctl } = setup();
    ctl.setTool("rect");
    ctl.down({ x: 100, y: 300 });
    ctl.move({ x: 150, y: 250 }, true);
    ctl.up({ x: 150, y: 250 });
    expect(ctl.drawings[0]).toMatchObject({ type: "rect", points: [at(10, 100), at(15, 125)] });
  });

  it("places a parallel channel with three clicks", () => {
    const { ctl } = setup();
    ctl.setTool("channel");
    for (const p of [{ x: 0, y: 300 }, { x: 100, y: 260 }, { x: 50, y: 260 }]) {
      ctl.move(p, false);
      ctl.down(p);
      ctl.up(p);
    }
    // The third click is 20 px above the base line (y 280 at x 50).
    expect(ctl.drawings[0]!.points).toEqual([at(0, 100), at(10, 120), at(0, 110)]);
  });

  it("lets presses on empty chart through, so the chart can pan", () => {
    const { ctl } = setup();
    ctl.load([hline]);
    expect(ctl.down({ x: 400, y: 100 })).toBe(false);
  });

  it("selects and drags a drawing, deletes it, and undoes and redoes", () => {
    const { ctl, changed } = setup();
    ctl.load([hline]);
    expect(ctl.down({ x: 400, y: 302 })).toBe(true);
    expect(ctl.selected).toBe("h");
    ctl.move({ x: 430, y: 282 }, true);
    ctl.up({ x: 430, y: 282 });
    expect(ctl.drawings[0]!.points).toEqual([at(8, 110)]);
    expect(changed).toHaveLength(1);
    expect(ctl.key(key("Delete"))).toBe(true);
    expect(ctl.drawings).toEqual([]);
    ctl.undo();
    expect(ctl.drawings[0]!.points).toEqual([at(8, 110)]);
    ctl.undo();
    expect(ctl.drawings[0]!.points).toEqual([at(5, 100)]);
    ctl.redo();
    expect(ctl.drawings[0]!.points).toEqual([at(8, 110)]);
    expect(ctl.canRedo).toBe(true);
  });

  it("reshapes a line by dragging one end", () => {
    const { ctl } = setup();
    ctl.load([trend]);
    ctl.down({ x: 200, y: 260 }); // the second point's handle
    ctl.move({ x: 300, y: 200 }, true);
    ctl.up({ x: 300, y: 200 });
    expect(ctl.drawings[0]!.points).toEqual([at(10, 100), at(30, 150)]);
  });

  it("ignores a click on a drawing that doesn't move it", () => {
    const { ctl, changed } = setup();
    ctl.load([trend]);
    ctl.down({ x: 150, y: 280 });
    ctl.move({ x: 151, y: 281 }, true);
    ctl.up({ x: 151, y: 281 });
    expect(ctl.drawings[0]).toBe(trend);
    expect(changed).toHaveLength(0);
  });

  it("snaps to the nearest open, high, low or close with the magnet on", () => {
    const { ctl } = setup();
    ctl.setToggle("magnet", true);
    ctl.setTool("hline");
    ctl.down({ x: 100, y: 283 }); // price 108.5; the high (110) is 3 px away
    expect(ctl.drawings[0]!.points).toEqual([at(10, 110)]);
  });

  it("keeps new text notes only once they have text", () => {
    const { ctl, changed, host } = setup();
    ctl.setTool("text");
    ctl.down({ x: 100, y: 300 });
    expect(host.editText).toHaveBeenCalledOnce();
    ctl.setText(ctl.drawings[0]!.id, "  ");
    expect(ctl.drawings).toEqual([]);
    expect(changed).toHaveLength(0);
    expect(ctl.canUndo).toBe(false);
    ctl.setTool("text");
    ctl.down({ x: 100, y: 300 });
    ctl.setText(ctl.drawings[0]!.id, "Breakout");
    expect(ctl.drawings[0]!.text).toBe("Breakout");
    expect(changed).toHaveLength(1);
    ctl.undo();
    expect(ctl.drawings).toEqual([]);
  });

  it("can't touch drawings while they're locked", () => {
    const { ctl } = setup();
    ctl.load([hline]);
    ctl.setToggle("locked", true);
    expect(ctl.down({ x: 400, y: 300 })).toBe(false);
    expect(ctl.selected).toBeNull();
  });

  it("switches tools with Alt shortcuts and cancels a half-placed drawing with Escape", () => {
    const { ctl } = setup();
    expect(ctl.key(key("KeyT", { key: "†", altKey: true }))).toBe(true);
    expect(ctl.tool).toBe("trend");
    ctl.down({ x: 100, y: 300 });
    expect(ctl.key(key("Escape"))).toBe(true);
    expect(ctl.draft).toBeNull();
    expect(ctl.tool).toBe("cursor");
    expect(ctl.drawings).toEqual([]);
    expect(ctl.key(key("Escape"))).toBe(false); // nothing left to cancel
  });

  it("zooms to a box dragged with the zoom tool", () => {
    const { ctl, host } = setup();
    ctl.setTool("zoom");
    ctl.down({ x: 100, y: 100 });
    ctl.move({ x: 300, y: 200 }, true);
    ctl.up({ x: 300, y: 200 });
    expect(host.zoomTo).toHaveBeenCalledWith({ x: 100, y: 100 }, { x: 300, y: 200 });
    expect(ctl.tool).toBe("cursor");
  });
});
