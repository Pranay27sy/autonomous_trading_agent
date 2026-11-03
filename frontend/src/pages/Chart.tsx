import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError, type StockListItem, type Trade } from "../api";
import type { Tool } from "../chart/controller";
import { PALETTE, TEXT_SIZES, TOOLS, sanitize, toPixel, type Drawing, type DrawingStyle } from "../chart/drawings";
import { CHART_TYPES, ChartEngine, type ChartType, type DrawnIndicator, type RangeKey } from "../chart/engine";
import { Icon } from "../chart/icons";
import { INDICATORS, cleanParams, indicatorDef, indicatorLabel, type IndicatorConfig, type IndicatorKind } from "../chart/indicators";
import { loadSettings, newIndicator, useChartSettings, type ChartSettings } from "../chart/settings";
import type { Interval } from "../chart/timeIndex";
import { StockSearch } from "../components/StockSearch";
import { Empty, ErrorBox, Segmented, Skeleton, Switch } from "../components/ui";
import { useFilters } from "../filters";
import { day, inr } from "../format";

const INTERVALS: Record<Interval, string> = { D: "1D", W: "1W", M: "1M" };
const RANGES: RangeKey[] = ["1M", "3M", "6M", "YTD", "1Y", "5Y", "All"];
const TOOL_GROUPS: Tool[][] = [
  ["cursor", "zoom"],
  ["trend", "ray", "extended", "arrow"],
  ["hline", "hray", "vline"],
  ["rect", "channel"],
  ["fib", "measure", "text"],
];
const SAVE_DELAY_MS = 600;
const noUpdates = () => () => {};

type Saving = { state: "idle" | "saving" | "saved" } | { state: "error"; message: string };
type SaveJob = { symbol: string; drawings: Drawing[] };

/** /chart/:symbol, or /chart for the last stock charted (else the most active one). */
export function Chart() {
  const { symbol } = useParams();
  const { search } = useLocation();
  const [f] = useFilters();
  const stocks = useQuery({ queryKey: ["stocks", f], queryFn: () => api.stocks(f), placeholderData: keepPreviousData });
  if (!symbol) {
    const go = loadSettings().lastSymbol ?? stocks.data?.[0]?.symbol;
    if (go) return <Navigate replace to={{ pathname: `/chart/${encodeURIComponent(go)}`, search }} />;
    if (stocks.error) return <ErrorBox error={stocks.error} />;
    if (!stocks.data) return <Skeleton height={520} />;
    return <Empty title="No stocks yet">Refresh the data from the menu at the top right.</Empty>;
  }
  return <ChartView symbol={symbol.toUpperCase()} stocks={stocks.data ?? []} />;
}

function ChartView({ symbol, stocks }: { symbol: string; stocks: StockListItem[] }) {
  const [f] = useFilters();
  const qc = useQueryClient();
  const [settings, update] = useChartSettings();
  const stock = useQuery({ queryKey: ["stock", symbol, f], queryFn: () => api.stock(symbol, f), placeholderData: keepPreviousData });
  const saved = useQuery({ queryKey: ["drawings", symbol], queryFn: () => api.drawings(symbol), staleTime: Infinity });
  const workspace = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ChartEngine | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>({ state: "idle" });
  const height = useFillHeight(workspace);
  const [fullscreen, toggleFullscreen] = useFullscreen(workspace);

  // Drawings are saved shortly after each change, one request at a time.
  const pending = useRef<SaveJob | null>(null);
  const failed = useRef<SaveJob | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  /** The stock whose drawings are on the chart. */
  const shown = useRef<string | null>(null);
  const flush = useCallback(
    (keepalive = false) => {
      window.clearTimeout(timer.current);
      const job = pending.current;
      if (!job) return;
      pending.current = null;
      setSaving({ state: "saving" });
      // Browsers cap requests that outlive the page (keepalive) at 64 KB.
      const outlive = keepalive && JSON.stringify(job.drawings).length < 60_000;
      queue.current = queue.current.then(() =>
        api.saveDrawings(job.symbol, job.drawings, outlive).then(
          (r) => {
            failed.current = null;
            qc.setQueryData(["drawings", job.symbol], { symbol: job.symbol, drawings: job.drawings, updated_at: r.updated_at });
            setSaving({ state: "saved" });
          },
          (err: unknown) => {
            failed.current = job;
            setSaving({ state: "error", message: err instanceof Error ? err.message : "the server didn't answer" });
          },
        ),
      );
    },
    [qc],
  );
  const retry = () => {
    pending.current ??= failed.current;
    flush();
  };

  const initial = useRef(settings);
  useEffect(() => {
    const e = new ChartEngine(box.current!, {
      changed: (drawings) => {
        if (!shown.current) return;
        pending.current = { symbol: shown.current, drawings };
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(), SAVE_DELAY_MS);
      },
      stateChanged: () => {},
      editText: (id) => setEditing(id),
    });
    e.ctl.magnet = initial.current.magnet;
    e.ctl.stay = initial.current.stay;
    e.ctl.styles = { ...initial.current.styles };
    shown.current = null;
    setEngine(e);
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush(true);
      e.destroy();
      setEngine(null);
    };
  }, [flush]);

  // Show a stock once both its prices and its saved drawings are here, so the drawings
  // always belong to the chart they're on.
  const data = stock.data;
  const drawings = saved.data;
  const drawingsFailed = !!saved.error;
  useEffect(() => {
    if (!engine || !data) return;
    if (data.symbol === symbol && shown.current !== symbol && (drawings?.symbol === symbol || drawingsFailed)) {
      flush(); // the previous stock's last changes
      shown.current = symbol;
      engine.ctl.load(drawings?.symbol === symbol ? sanitize(drawings.drawings) : []);
      // Without the saved drawings, saving would overwrite them: drawing stays off.
      engine.ctl.enabled = drawings?.symbol === symbol;
      setEditing(null);
      update({ lastSymbol: symbol });
    }
    if (data.symbol !== shown.current) return;
    engine.update({
      symbol: data.symbol,
      bars: data.prices,
      interval: settings.interval,
      type: settings.type,
      scale: settings.scale,
      indicators: settings.indicators,
      trades: data.trades,
      showTrades: settings.showTrades,
      patterns: data.patterns,
      showPatterns: settings.showPatterns,
    });
  }, [engine, data, drawings, drawingsFailed, symbol, flush, update, settings.interval, settings.type, settings.scale, settings.indicators, settings.showTrades, settings.showPatterns]);

  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']") || document.querySelector(".palette-backdrop")) return;
      if (engine.ctl.key(e)) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === "+" || e.key === "=") engine.zoom(0.8);
      else if (e.key === "-" || e.key === "_") engine.zoom(1.25);
      else if (e.altKey && e.code === "KeyR") engine.resetView();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  const ready = !!data && data.symbol === symbol && shown.current === symbol;
  const company = ready ? data.company : null;
  const notFound = stock.error instanceof ApiError && stock.error.status === 404;
  const restyle = (patch: Partial<DrawingStyle>) => {
    if (!engine) return;
    engine.ctl.setStyle(patch);
    update({ styles: { ...engine.ctl.styles } });
  };
  const screenshot = () => {
    const last = engine?.candles.at(-1);
    if (!engine || !last) return;
    const title = [symbol, company, INTERVALS[settings.interval], `to ${day(last.time)}`].filter(Boolean).join(" · ");
    engine.screenshot(`${symbol}-${last.time}.png`, title);
  };

  return (
    <div
      ref={workspace}
      className={`chart-workspace${fullscreen ? " is-fullscreen" : ""}`}
      style={fullscreen || height == null ? undefined : { height }}
    >
      <ChartToolbar
        engine={engine}
        symbol={symbol}
        stocks={stocks}
        settings={settings}
        update={update}
        saving={saving}
        onRetry={retry}
        onScreenshot={screenshot}
        fullscreen={fullscreen}
        toggleFullscreen={toggleFullscreen}
      />
      <div className="chart-body">
        {engine && <DrawToolbar engine={engine} update={update} />}
        <div className="chart-stage">
          <div className="chart-canvas" ref={box} role="img" aria-label={`Interactive price chart for ${symbol}`} />
          {engine && ready && <Legend engine={engine} symbol={symbol} company={company} settings={settings} update={update} />}
          {engine && ready && <SelectionBar engine={engine} onStyle={restyle} onEditText={setEditing} />}
          {engine && editing && <TextEditor key={editing} engine={engine} id={editing} onDone={() => setEditing(null)} />}
          {engine && ready && <LatestButton engine={engine} />}
          {drawingsFailed && ready && (
            <div className="chart-banner neg" role="alert">
              Couldn't load the drawings for {symbol}, so drawing is off to avoid overwriting them. Reload to try again.
            </div>
          )}
          {stock.error ? (
            <div className="chart-overlay">
              {notFound ? (
                <Empty title={`No prices for ${symbol}`}>
                  <p>Check the symbol or pick another stock above.</p>
                </Empty>
              ) : (
                <ErrorBox error={stock.error} />
              )}
            </div>
          ) : (
            !ready && <div className="chart-overlay faint mono">Loading {symbol}…</div>
          )}
        </div>
      </div>
      <ChartBottomBar engine={engine} settings={settings} update={update} />
    </div>
  );
}

// --- toolbars -----------------------------------------------------------------------

function ChartToolbar(props: {
  engine: ChartEngine | null;
  symbol: string;
  stocks: StockListItem[];
  settings: ChartSettings;
  update: (patch: Partial<ChartSettings>) => void;
  saving: Saving;
  onRetry: () => void;
  onScreenshot: () => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
}) {
  const { engine, symbol, settings, update } = props;
  const navigate = useNavigate();
  const { search } = useLocation();
  return (
    <div className="chart-toolbar">
      <div className="chart-symbol">
        <StockSearch
          stocks={props.stocks}
          placeholder={`${symbol} · change stock`}
          onPick={(s) => navigate({ pathname: `/chart/${encodeURIComponent(s.symbol)}`, search })}
        />
      </div>
      <Segmented label="Interval" options={["D", "W", "M"] as const} value={settings.interval} format={(i) => INTERVALS[i]} onChange={(interval) => update({ interval })} />
      <select className="select" aria-label="Chart type" value={settings.type} onChange={(e) => update({ type: e.target.value as ChartType })}>
        {CHART_TYPES.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
      <IndicatorMenu
        existing={settings.indicators}
        onAdd={(kind) => update({ indicators: [...settings.indicators, newIndicator(kind, settings.indicators)] })}
      />
      <UndoRedo engine={engine} />
      <Switch label="Promoter trades" checked={settings.showTrades} onChange={(showTrades) => update({ showTrades })} title="▲ promoter buys and ▼ sells, sized by value" />
      <Switch label="Patterns" checked={settings.showPatterns} onChange={(showPatterns) => update({ showPatterns })} title="Chart patterns found by the scanner" />
      <span className="chart-toolbar-end">
        <SaveStatus saving={props.saving} onRetry={props.onRetry} />
        <Link className="btn" to={{ pathname: `/stock/${encodeURIComponent(symbol)}`, search }} title="Promoter trades and returns for this stock">
          Stock page
        </Link>
        <button type="button" className="icon-btn" title="Save a picture of the chart (PNG)" aria-label="Screenshot" onClick={props.onScreenshot}>
          <Icon name="camera" />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={props.fullscreen ? "Exit full screen" : "Full screen"}
          aria-label={props.fullscreen ? "Exit full screen" : "Full screen"}
          onClick={props.toggleFullscreen}
        >
          <Icon name={props.fullscreen ? "exitFullscreen" : "fullscreen"} />
        </button>
      </span>
    </div>
  );
}

/** Undo and redo for drawings, like the arrows in a trading terminal's top bar. */
function UndoRedo({ engine }: { engine: ChartEngine | null }) {
  useSyncExternalStore(engine?.subscribe ?? noUpdates, () => engine?.uiVersion ?? 0);
  const ctl = engine?.ctl;
  return (
    <div className="seg" role="group" aria-label="Undo and redo">
      <button type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!ctl?.canUndo} onClick={() => ctl?.undo()}>
        <Icon name="undo" size={14} />
      </button>
      <button type="button" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!ctl?.canRedo} onClick={() => ctl?.redo()}>
        <Icon name="redo" size={14} />
      </button>
    </div>
  );
}

/** Under the chart: date ranges and zoom on the left, the price scale on the right. */
function ChartBottomBar({ engine, settings, update }: { engine: ChartEngine | null; settings: ChartSettings; update: (patch: Partial<ChartSettings>) => void }) {
  return (
    <div className="chart-bottombar">
      <div className="seg" role="group" aria-label="Show a date range">
        {RANGES.map((r) => (
          <button key={r} type="button" title={r === "All" ? "All the history" : r === "YTD" ? "Since 1 January" : `The last ${r}`} onClick={() => engine?.showRange(r)}>
            {r}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Zoom">
        <button type="button" title="Zoom out (−)" aria-label="Zoom out" onClick={() => engine?.zoom(1.25)}>
          <Icon name="zoomOut" size={14} />
        </button>
        <button type="button" title="Zoom in (+)" aria-label="Zoom in" onClick={() => engine?.zoom(0.8)}>
          <Icon name="zoomIn" size={14} />
        </button>
        <button type="button" title="Reset the view (Alt+R)" aria-label="Reset view" onClick={() => engine?.resetView()}>
          <Icon name="reset" size={14} />
        </button>
        <button type="button" title="Fit all the history" aria-label="Fit all" onClick={() => engine?.fitAll()}>
          <Icon name="fit" size={14} />
        </button>
      </div>
      <span className="faint chart-hint">Scroll to zoom · drag to pan · drag the price axis to stretch it</span>
      <div className="chart-bottombar-end">
        <Segmented
          label="Price scale"
          options={["linear", "log", "percent"] as const}
          value={settings.scale}
          format={(s) => ({ linear: "Linear", log: "Log", percent: "%" })[s]}
          onChange={(scale) => update({ scale })}
        />
        <button type="button" className="btn" title="Fit prices to the bars on screen" onClick={() => engine?.autoScale()}>
          Auto
        </button>
      </div>
    </div>
  );
}

function SaveStatus({ saving, onRetry }: { saving: Saving; onRetry: () => void }) {
  if (saving.state === "error") {
    return (
      <span className="save-status neg" role="alert">
        Drawings not saved: {saving.message}.{" "}
        <button type="button" className="btn-link" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  }
  if (saving.state === "idle") return null;
  return <span className="save-status faint">{saving.state === "saving" ? "Saving…" : "Drawings saved"}</span>;
}

function IndicatorMenu({ existing, onAdd }: { existing: IndicatorConfig[]; onAdd: (kind: IndicatorKind) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useDismiss(open, anchor, () => setOpen(false));
  return (
    <div className="popover-anchor" ref={anchor}>
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <Icon name="indicators" size={14} /> Indicators
      </button>
      {open && (
        <div className="popover ind-menu" role="menu">
          {INDICATORS.map((d) => (
            <button
              key={d.kind}
              type="button"
              role="menuitem"
              disabled={d.kind === "volume" && existing.some((e) => e.kind === "volume")}
              onClick={() => {
                onAdd(d.kind);
                setOpen(false);
              }}
            >
              <span>{d.name}</span>
              <span className="faint mono">{d.pane === "own" ? "pane" : "on price"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- drawing tools --------------------------------------------------------------------

function toolTitle(tool: Tool): string {
  if (tool === "cursor") return "Cursor: select and move drawings (Esc)";
  if (tool === "zoom") return "Zoom: drag a box to zoom into (Alt+Z)";
  const spec = TOOLS[tool];
  return spec.shortcut ? `${spec.label} (Alt+${spec.shortcut.slice(3)})` : spec.label;
}

function DrawToolbar({ engine, update }: { engine: ChartEngine; update: (patch: Partial<ChartSettings>) => void }) {
  useSyncExternalStore(engine.subscribe, () => engine.uiVersion);
  const ctl = engine.ctl;
  const toggle = (name: "magnet" | "stay" | "locked" | "hidden", on: boolean) => {
    ctl.setToggle(name, on);
    if (name === "magnet" || name === "stay") update({ [name]: on });
  };
  const toggles = [
    { name: "magnet", icon: "magnet", title: "Magnet: snap points to the nearest open, high, low or close" },
    { name: "stay", icon: "stay", title: "Keep drawing: stay on the tool after each drawing" },
    { name: "locked", icon: "lock", title: "Lock all drawings" },
    { name: "hidden", icon: ctl.hidden ? "eyeOff" : "eye", title: ctl.hidden ? "Show drawings" : "Hide all drawings" },
  ] as const;
  return (
    <div className="draw-toolbar" role="toolbar" aria-label="Drawing tools">
      {TOOL_GROUPS.map((group, i) => (
        <div className="tool-group" key={i}>
          {group.map((tool) => (
            <button
              key={tool}
              type="button"
              className="tool"
              aria-pressed={ctl.tool === tool}
              title={toolTitle(tool)}
              aria-label={toolTitle(tool)}
              disabled={!ctl.enabled}
              onClick={() => ctl.setTool(tool)}
            >
              <Icon name={tool} />
            </button>
          ))}
        </div>
      ))}
      <div className="tool-group">
        {toggles.map((t) => (
          <button
            key={t.name}
            type="button"
            className="tool"
            aria-pressed={ctl[t.name]}
            title={t.title}
            aria-label={t.title}
            onClick={() => toggle(t.name, !ctl[t.name])}
          >
            <Icon name={t.icon} />
          </button>
        ))}
        <button
          type="button"
          className="tool danger"
          title="Remove all drawings on this chart"
          aria-label="Remove all drawings"
          disabled={!ctl.drawings.length || ctl.locked}
          onClick={() => {
            const n = ctl.drawings.length;
            if (window.confirm(`Remove all ${n} drawing${n === 1 ? "" : "s"} on this chart? You can undo this.`)) ctl.clear();
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

/** Style controls for the selected drawing, floating over the chart. */
function SelectionBar({ engine, onStyle, onEditText }: { engine: ChartEngine; onStyle: (p: Partial<DrawingStyle>) => void; onEditText: (id: string) => void }) {
  useSyncExternalStore(engine.subscribe, () => engine.uiVersion);
  const d = engine.ctl.selectedDrawing;
  if (!d || engine.ctl.locked || engine.ctl.hidden) return null;
  const text = d.type === "text";
  return (
    <div className="selection-bar" role="toolbar" aria-label={`${TOOLS[d.type].label} style`}>
      <span className="faint mono selection-name">{TOOLS[d.type].label}</span>
      {d.type !== "measure" && (
        <div className="swatches" role="group" aria-label="Color">
          {PALETTE.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={d.color === c} onClick={() => onStyle({ color: c })} />
          ))}
        </div>
      )}
      <div className="seg" role="group" aria-label={text ? "Text size" : "Line width"}>
        {([1, 2, 3, 4] as const).map((w) => (
          <button key={w} type="button" aria-pressed={d.width === w} title={text ? `${TEXT_SIZES[w - 1]}px text` : `${w}px line`} onClick={() => onStyle({ width: w })}>
            {text ? TEXT_SIZES[w - 1] : <LineSample width={w} style="solid" />}
          </button>
        ))}
      </div>
      {!text && d.type !== "measure" && (
        <div className="seg" role="group" aria-label="Line style">
          {(["solid", "dashed", "dotted"] as const).map((st) => (
            <button key={st} type="button" aria-pressed={d.style === st} title={`${st[0]!.toUpperCase()}${st.slice(1)} line`} onClick={() => onStyle({ style: st })}>
              <LineSample width={2} style={st} />
            </button>
          ))}
        </div>
      )}
      {text && (
        <button type="button" className="btn" onClick={() => onEditText(d.id)}>
          Edit text
        </button>
      )}
      <button type="button" className="icon-btn" title="Clone" aria-label="Clone" onClick={() => engine.ctl.clone()}>
        <Icon name="clone" />
      </button>
      <button type="button" className="icon-btn danger" title="Delete (Del)" aria-label="Delete drawing" onClick={() => engine.ctl.deleteSelected()}>
        <Icon name="trash" />
      </button>
    </div>
  );
}

function LineSample({ width, style }: { width: number; style: "solid" | "dashed" | "dotted" }) {
  const dash = style === "dashed" ? "5 3" : style === "dotted" ? "1 3" : undefined;
  return (
    <svg width="22" height="10" aria-hidden="true">
      <line x1="2" y1="5" x2="20" y2="5" stroke="currentColor" strokeWidth={width} strokeDasharray={dash} strokeLinecap={style === "dotted" ? "round" : "butt"} />
    </svg>
  );
}

function TextEditor({ engine, id, onDone }: { engine: ChartEngine; id: string; onDone: () => void }) {
  useSyncExternalStore(engine.subscribe, () => engine.version); // follow the chart as it scrolls
  const d = engine.ctl.drawings.find((x) => x.id === id);
  const [text, setText] = useState(d?.text ?? "");
  const finished = useRef(false);
  const vp = engine.viewport();
  if (!d || !vp) return null;
  const at = toPixel(vp, d.points[0]!);
  const finish = (value: string) => {
    if (finished.current) return;
    finished.current = true;
    engine.ctl.setText(id, value);
    onDone();
  };
  return (
    <input
      className="chart-text-input"
      autoFocus
      aria-label="Note text"
      placeholder="Type a note, then Enter"
      value={text}
      maxLength={500}
      style={{ left: at.x, top: at.y, color: d.color, fontSize: TEXT_SIZES[d.width - 1] }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        else if (e.key === "Escape") finish(d.text ?? "");
      }}
      onBlur={() => finish(text)}
    />
  );
}

function LatestButton({ engine }: { engine: ChartEngine }) {
  useSyncExternalStore(engine.subscribe, () => engine.uiVersion);
  if (engine.atLatest) return null;
  return (
    <button type="button" className="icon-btn chart-latest" title="Scroll to the latest bar" aria-label="Scroll to the latest bar" onClick={() => engine.scrollToLatest()}>
      <Icon name="latest" />
    </button>
  );
}

// --- legend -------------------------------------------------------------------------

const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function Legend(props: {
  engine: ChartEngine;
  symbol: string;
  company: string | null;
  settings: ChartSettings;
  update: (patch: Partial<ChartSettings>) => void;
}) {
  const { engine, settings, update } = props;
  useSyncExternalStore(engine.subscribe, () => engine.version);
  const candles = engine.candles;
  const i = engine.hover ?? candles.length - 1;
  const c = candles[i];
  if (!c) return null;
  const prev = candles[i - 1];
  const change = prev ? c.close - prev.close : 0;
  const cls = change >= 0 ? "pos" : "neg";
  const trades = engine.byBar.get(c.time) ?? [];
  const setConfig = (next: IndicatorConfig | null, id: string) =>
    update({
      indicators: next
        ? settings.indicators.map((x) => (x.id === id ? next : x))
        : settings.indicators.filter((x) => x.id !== id),
    });
  const row = (d: DrawnIndicator) => <IndicatorRow key={d.config.id} drawn={d} index={i} onChange={(next) => setConfig(next, d.config.id)} />;
  const panes = [...new Set(engine.indicators.filter((d) => d.pane > 0).map((d) => d.pane))];
  return (
    <>
      <div className="chart-legend" style={{ top: 6 }}>
        <div className="legend-title">
          <b>{props.symbol}</b>
          {props.company && <span className="muted clip-text">{props.company}</span>}
          <span className="faint mono">
            {INTERVALS[settings.interval]} · {settings.interval === "D" ? day(c.time) : `from ${day(c.time)}`}
          </span>
        </div>
        <div className="legend-ohlc mono">
          {c.closeOnly ? (
            <span>
              C <b className={cls}>{num(c.close)}</b>
            </span>
          ) : (
            (["open", "high", "low", "close"] as const).map((k) => (
              <span key={k}>
                {k[0]!.toUpperCase()} <b className={cls}>{num(c[k])}</b>
              </span>
            ))
          )}
          {prev && (
            <b className={cls}>
              {change >= 0 ? "+" : "−"}
              {num(Math.abs(change))} ({change >= 0 ? "+" : "−"}
              {num(Math.abs((change / prev.close) * 100))}%)
            </b>
          )}
        </div>
        {settings.showTrades && trades.length > 0 && <TradeLines trades={trades} />}
        {engine.indicators.filter((d) => d.pane <= 0).map(row)}
      </div>
      {panes.map((p) => (
        <div key={p} className="chart-legend" style={{ top: engine.paneTop(p) + 4 }}>
          {engine.indicators.filter((d) => d.pane === p).map(row)}
        </div>
      ))}
    </>
  );
}

function TradeLines({ trades }: { trades: Trade[] }) {
  return (
    <div className="legend-trades">
      {trades.slice(0, 3).map((t, k) => (
        <div key={k} className="legend-trade">
          <span className={`chip ${t.direction}`}>promoter {t.direction}</span>
          <span className="mono">{inr(t.value)}</span>
          <span className="muted clip-text">{t.person}</span>
        </div>
      ))}
      {trades.length > 3 && <div className="faint">+{trades.length - 3} more promoter trades</div>}
    </div>
  );
}

function IndicatorRow({ drawn, index, onChange }: { drawn: DrawnIndicator; index: number; onChange: (next: IndicatorConfig | null) => void }) {
  const [editing, setEditing] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useDismiss(editing, anchor, () => setEditing(false));
  const { config, lines } = drawn;
  const def = indicatorDef(config.kind);
  const digits = config.kind === "volume" ? 0 : 2;
  const shown = lines.filter((l) => l.values[index] != null);
  return (
    <div className={`legend-ind${config.hidden ? " is-hidden" : ""}`} ref={anchor}>
      <button
        type="button"
        className="ind-name mono"
        style={{ color: config.color }}
        title={`${def.name}: change settings`}
        aria-expanded={editing}
        onClick={() => setEditing(!editing)}
      >
        {indicatorLabel(config)}
      </button>
      {!config.hidden &&
        shown.map((l) => (
          <span key={l.name} className="mono" style={{ color: config.kind === "volume" ? undefined : l.color }}>
            {num(l.values[index], digits)}
          </span>
        ))}
      <button
        type="button"
        className="ind-btn"
        title={config.hidden ? "Show" : "Hide"}
        aria-label={`${config.hidden ? "Show" : "Hide"} ${indicatorLabel(config)}`}
        onClick={() => onChange({ ...config, hidden: !config.hidden })}
      >
        <Icon name={config.hidden ? "eyeOff" : "eye"} size={14} />
      </button>
      <button type="button" className="ind-btn" title="Remove" aria-label={`Remove ${indicatorLabel(config)}`} onClick={() => onChange(null)}>
        <Icon name="close" size={14} />
      </button>
      {editing && <IndicatorEditor config={config} onChange={onChange} />}
    </div>
  );
}

function IndicatorEditor({ config, onChange }: { config: IndicatorConfig; onChange: (next: IndicatorConfig) => void }) {
  const def = indicatorDef(config.kind);
  return (
    <div className="ind-editor" role="dialog" aria-label={`${def.name} settings`}>
      <div className="ind-editor-title">{def.name}</div>
      {def.params.map((p, k) => (
        <label key={p.label} className="ind-field">
          <span className="muted">{p.label}</span>
          <input
            type="number"
            className="input num-input"
            min={p.min}
            max={p.max}
            step={p.step}
            defaultValue={config.params[k]}
            onChange={(e) => {
              if (e.target.value === "") return;
              const params = [...config.params];
              params[k] = Number(e.target.value);
              onChange({ ...config, params: cleanParams(config.kind, params) });
            }}
          />
        </label>
      ))}
      {config.kind !== "volume" && config.kind !== "supertrend" && (
        <div className="swatches" role="group" aria-label="Color">
          {PALETTE.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={config.color === c} onClick={() => onChange({ ...config, color: c })} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- hooks --------------------------------------------------------------------------

/** Height that fills the window below the element's top, so the chart fits on screen. */
function useFillHeight(ref: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(460, Math.round(window.innerHeight - top - 12)));
    };
    fit();
    window.addEventListener("resize", fit);
    // The filter bar above wraps onto more lines on narrow screens.
    const bar = document.querySelector(".filterbar");
    const ro = bar ? new ResizeObserver(fit) : null;
    if (bar) ro!.observe(bar);
    return () => {
      window.removeEventListener("resize", fit);
      ro?.disconnect();
    };
  }, [ref]);
  return height;
}

function useFullscreen(ref: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [ref]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen?.().catch(() => {});
  };
  return [on, toggle];
}

/** Close a popover on a click outside it or on Escape. */
function useDismiss(open: boolean, anchor: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !anchor.current?.contains(e.target as Node)) latest.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onDown);
    };
  }, [open, anchor]);
}

