// Mouse/touch/keyboard handling for chart drawings: placing them (click-click or
// press-drag-release), selecting, moving, reshaping by their handles, deleting, and
// undo/redo. Works in pane pixels through a Viewport, so it's independent of the chart
// library and testable on its own.
import {
  DRAWING_TYPES,
  TOOLS,
  hitHandle,
  hitShape,
  moveBy,
  moveHandle,
  newDrawing,
  newId,
  placing,
  shapeOf,
  type Anchor,
  type Drawing,
  type DrawingStyle,
  type DrawingType,
  type P,
  type Shape,
  type Viewport,
} from "./drawings";

export type Tool = DrawingType | "cursor" | "zoom";

export interface ControllerHost {
  /** The current view, or null while the chart has no data. */
  viewport(): Viewport | null;
  /** Redraw the drawings. */
  repaint(): void;
  /** The user changed the drawings: save them. */
  changed(drawings: Drawing[]): void;
  /** Tool, selection, toggles or history changed: update the toolbars. */
  stateChanged(): void;
  /** Open the text editor for a text note. */
  editText(id: string): void;
  /** Zoom to the box dragged with the zoom tool. */
  zoomTo(a: P, b: P): void;
}

export interface RenderItem {
  drawing: Drawing;
  shape: Shape;
  state: "normal" | "hovered" | "selected" | "draft";
}

interface Draft {
  drawing: Drawing;
  /** Points fixed so far; the next one follows the pointer. */
  placed: number;
  /** Where the current press started, to tell a drag from a click. */
  down: P | null;
  dragged: boolean;
}

interface Drag {
  id: string;
  /** Handle being dragged, or -1 to move the whole drawing. */
  handle: number;
  start: P;
  orig: Drawing;
  before: Drawing[];
  moved: boolean;
}

const MAX_HISTORY = 200;
/** Pointer travel (px) that turns a press into a drag. */
const DRAG_PX = 4;

export class DrawingController {
  drawings: Drawing[] = [];
  tool: Tool = "cursor";
  selected: string | null = null;
  hovered: string | null = null;
  /** Snap points to the nearest open/high/low/close. */
  magnet = false;
  /** Keep the drawing tool after placing one, instead of going back to the cursor. */
  stay = false;
  /** Drawings can't be selected, moved or deleted. */
  locked = false;
  hidden = false;
  /** Off while a stock's drawings are loading. */
  enabled = true;
  /** Last style used per tool, for the next drawing of that kind. */
  styles: Partial<Record<DrawingType, DrawingStyle>> = {};
  draft: Draft | null = null;
  zoomBox: { a: P; b: P } | null = null;
  private drag: Drag | null = null;
  private pendingText: string | null = null;
  private undoStack: Drawing[][] = [];
  private redoStack: Drawing[][] = [];

  constructor(private host: ControllerHost) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get selectedDrawing(): Drawing | null {
    return this.drawings.find((d) => d.id === this.selected) ?? null;
  }

  /** Show a stock's saved drawings; history starts over. */
  load(drawings: Drawing[]): void {
    this.drawings = drawings;
    this.selected = this.hovered = this.pendingText = null;
    this.draft = this.drag = this.zoomBox = null;
    this.undoStack = [];
    this.redoStack = [];
    this.notify();
  }

  setTool(tool: Tool): void {
    this.draft = this.zoomBox = null;
    this.tool = tool;
    if (tool !== "cursor") {
      this.selected = null;
      this.hidden = false;
    }
    this.notify();
  }

  setToggle(name: "magnet" | "stay" | "locked" | "hidden", on: boolean): void {
    this[name] = on;
    if ((name === "locked" || name === "hidden") && on) this.selected = this.hovered = null;
    this.notify();
  }

  styleFor(type: DrawingType): DrawingStyle {
    return { ...TOOLS[type].style, ...this.styles[type] };
  }

  // --- pointer input (pane pixels) ---------------------------------------------------

  /** A press at p. Returns true if drawing took it, so the chart mustn't pan. */
  down(p: P): boolean {
    const vp = this.host.viewport();
    if (!vp || !this.enabled) return false;
    if (this.draft) {
      this.placeNext(this.anchor(p, vp), vp);
      if (this.draft) this.draft.down = p;
      return true;
    }
    if (this.tool === "zoom") {
      this.zoomBox = { a: p, b: p };
      return true;
    }
    if (this.tool !== "cursor") {
      const drawing = newDrawing(this.tool, this.anchor(p, vp), this.styleFor(this.tool));
      this.selected = null;
      this.draft = { drawing, placed: 1, down: p, dragged: false };
      if (TOOLS[this.tool].points === 1) this.finishDraft();
      else this.host.repaint();
      return true;
    }
    const hit = this.hitAt(p);
    if (!hit) {
      if (this.selected) {
        this.selected = null;
        this.notify();
      }
      return false;
    }
    const orig = this.drawings.find((d) => d.id === hit.id)!;
    this.selected = hit.id;
    this.drag = { id: hit.id, handle: hit.handle, start: p, orig, before: this.drawings, moved: false };
    this.notify();
    return true;
  }

  /** The pointer moved to p, with the button held (pressed) or not. */
  move(p: P, pressed: boolean): void {
    const vp = this.host.viewport();
    if (!vp) return;
    const dr = this.draft;
    if (dr) {
      if (pressed && dr.down && Math.hypot(p.x - dr.down.x, p.y - dr.down.y) > DRAG_PX) dr.dragged = true;
      dr.drawing = placing(dr.drawing, dr.placed, this.anchor(p, vp), vp);
      this.host.repaint();
      return;
    }
    if (this.zoomBox) {
      if (pressed) {
        this.zoomBox.b = p;
        this.host.repaint();
      }
      return;
    }
    const g = this.drag;
    if (g) {
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) <= DRAG_PX) return;
      g.moved = true;
      const next =
        g.handle >= 0
          ? moveHandle(g.orig, g.handle, this.anchor(p, vp), vp)
          : moveBy(g.orig, Math.round(vp.logicalAt(p.x) - vp.logicalAt(g.start.x)), p.y - g.start.y, vp);
      this.drawings = this.drawings.map((d) => (d.id === g.id ? next : d));
      this.host.repaint();
      return;
    }
    const hovered = this.hitAt(p)?.id ?? null;
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.host.repaint();
    }
  }

  /** The press ended at p. */
  up(p: P): void {
    const vp = this.host.viewport();
    const dr = this.draft;
    if (dr) {
      const dragged = dr.dragged;
      dr.down = null;
      dr.dragged = false;
      // Press-drag-release places the next point where the button came up.
      if (dragged && vp) this.placeNext(this.anchor(p, vp), vp);
      return;
    }
    if (this.zoomBox) {
      const { a, b } = this.zoomBox;
      this.zoomBox = null;
      if (Math.abs(b.x - a.x) > 8) {
        this.host.zoomTo(a, b);
        if (!this.stay) this.tool = "cursor";
      }
      this.notify();
      return;
    }
    const g = this.drag;
    this.drag = null;
    if (g?.moved) this.commit(g.before);
  }

  /** A press outside the drawing area: drop the selection (a half-placed drawing stays). */
  deselect(): void {
    if (this.selected && !this.draft) {
      this.selected = null;
      this.notify();
    }
  }

  /** The pointer left the chart. */
  leave(): void {
    if (this.hovered) {
      this.hovered = null;
      this.host.repaint();
    }
  }

  /** Double click: edit a text note. Returns true if it was on one. */
  doubleClick(p: P): boolean {
    const hit = this.hitAt(p);
    const d = hit && this.drawings.find((x) => x.id === hit.id);
    if (d?.type !== "text") return false;
    this.selected = d.id;
    this.notify();
    this.host.editText(d.id);
    return true;
  }

  /** The drawing (and handle, or -1 for its body) under p, topmost first. */
  hitAt(p: P): { id: string; handle: number } | null {
    const vp = this.host.viewport();
    if (!vp || !this.enabled || this.hidden || this.locked || this.tool !== "cursor" || this.draft) return null;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i]!;
      const shape = shapeOf(d, vp);
      const handle = hitHandle(shape, p);
      if (handle >= 0) return { id: d.id, handle };
      if (hitShape(shape, p)) return { id: d.id, handle: -1 };
    }
    return null;
  }

  // --- commands -------------------------------------------------------------------------

  /** Esc: drop a half-placed drawing, or the selection, and go back to the cursor. */
  escape(): boolean {
    if (!this.draft && !this.zoomBox && !this.selected && this.tool === "cursor") return false;
    if (this.draft || this.zoomBox) this.draft = this.zoomBox = null;
    else this.selected = null;
    this.tool = "cursor";
    this.notify();
    return true;
  }

  deleteSelected(): void {
    if (!this.selected || this.locked) return;
    const before = this.drawings;
    this.drawings = before.filter((d) => d.id !== this.selected);
    this.selected = null;
    this.commit(before);
  }

  clear(): void {
    if (!this.drawings.length) return;
    const before = this.drawings;
    this.drawings = [];
    this.selected = null;
    this.commit(before);
  }

  /** Restyle the selected drawing; new drawings of its kind use the style too. */
  setStyle(patch: Partial<DrawingStyle>): void {
    const d = this.selectedDrawing;
    if (!d) return;
    const next = { ...d, ...patch };
    const before = this.drawings;
    this.drawings = before.map((x) => (x.id === d.id ? next : x));
    this.styles[d.type] = { color: next.color, width: next.width, style: next.style };
    this.commit(before);
  }

  /** Copy the selected drawing a few bars to the right and select the copy. */
  clone(): void {
    const d = this.selectedDrawing;
    const vp = this.host.viewport();
    if (!d || !vp) return;
    const copy = { ...moveBy(d, 5, 0, vp), id: newId() };
    const before = this.drawings;
    this.drawings = [...before, copy];
    this.selected = copy.id;
    this.commit(before);
  }

  /** Set a text note's text. Empty text removes the note. */
  setText(id: string, text: string): void {
    const value = text.trim().slice(0, 500);
    const isNew = this.pendingText === id;
    this.pendingText = null;
    const current = this.drawings.find((d) => d.id === id);
    if (!current) return;
    // A brand-new note was never committed, so cancelling it leaves no history.
    const before = isNew ? this.drawings.filter((d) => d.id !== id) : this.drawings;
    if (!value) {
      this.drawings = this.drawings.filter((d) => d.id !== id);
      this.selected = null;
      if (isNew) this.notify();
      else this.commit(before);
      return;
    }
    if (!isNew && current.text === value) return;
    this.drawings = this.drawings.map((d) => (d.id === id ? { ...d, text: value } : d));
    this.commit(before);
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.drawings);
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.drawings);
    this.restore(next);
  }

  /** Keyboard shortcuts for drawing. Returns true if the key was used. */
  key(e: { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") return this.escape();
    if ((e.key === "Delete" || e.key === "Backspace") && !mod && this.selected) {
      this.deleteSelected();
      return true;
    }
    if (mod && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
      if (e.code === "KeyY" || e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (e.altKey && !mod && !e.shiftKey) {
      if (e.code === "KeyZ") {
        this.setTool("zoom");
        return true;
      }
      const type = DRAWING_TYPES.find((t) => TOOLS[t].shortcut === e.code);
      if (type) {
        this.setTool(type);
        return true;
      }
    }
    return false;
  }

  /** What to draw: every drawing plus the one being placed. */
  renderList(vp: Viewport): RenderItem[] {
    if (this.hidden) return [];
    const out: RenderItem[] = this.drawings.map((d) => ({
      drawing: d,
      shape: shapeOf(d, vp),
      state: d.id === this.selected ? "selected" : d.id === this.hovered ? "hovered" : "normal",
    }));
    if (this.draft) out.push({ drawing: this.draft.drawing, shape: shapeOf(this.draft.drawing, vp), state: "draft" });
    return out;
  }

  // --- internals ------------------------------------------------------------------------

  /** Pointer position as a chart point: on a bar's time, and on its nearest OHLC with the magnet on. */
  private anchor(p: P, vp: Viewport): Anchor {
    const logical = Math.round(vp.logicalAt(p.x));
    let price = vp.price(p.y);
    const bar = this.magnet ? vp.bar(logical) : undefined;
    if (bar) {
      price = [bar.open, bar.high, bar.low, bar.close].reduce((best, v) =>
        Math.abs(vp.y(v) - p.y) < Math.abs(vp.y(best) - p.y) ? v : best,
      );
    }
    return { time: vp.timeAt(logical), price };
  }

  private placeNext(a: Anchor, vp: Viewport): void {
    const dr = this.draft!;
    dr.drawing = placing(dr.drawing, dr.placed, a, vp);
    dr.placed += 1;
    if (dr.placed >= TOOLS[dr.drawing.type].points) this.finishDraft();
    else this.host.repaint();
  }

  private finishDraft(): void {
    const d = this.draft!.drawing;
    this.draft = null;
    const before = this.drawings;
    this.drawings = [...before, d];
    this.selected = d.id;
    if (!this.stay) this.tool = "cursor";
    if (d.type === "text") {
      // Saved once it has text (setText).
      this.pendingText = d.id;
      this.notify();
      this.host.editText(d.id);
      return;
    }
    this.commit(before);
  }

  private commit(before: Drawing[]): void {
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.save();
    this.notify();
  }

  private restore(drawings: Drawing[]): void {
    this.drawings = drawings;
    this.draft = this.drag = null;
    if (this.selected && !drawings.some((d) => d.id === this.selected)) this.selected = null;
    this.save();
    this.notify();
  }

  /** Hand the drawings to the host to save, minus a note still waiting for its text. */
  private save(): void {
    this.host.changed(this.drawings.filter((d) => d.id !== this.pendingText));
  }

  private notify(): void {
    this.host.repaint();
    this.host.stateChanged();
  }
}
