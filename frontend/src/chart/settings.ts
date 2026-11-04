// Chart preferences (interval, style, indicators, drawing defaults), remembered per
// browser like a trading terminal's layout. Drawings themselves are saved per stock on
// the server.
import { useCallback, useEffect, useState } from "react";
import { DRAWING_TYPES, PALETTE, type DrawingStyle, type DrawingType } from "./drawings";
import type { ChartType, ScaleMode } from "./engine";
import { INDICATORS, cleanParams, type IndicatorConfig } from "./indicators";
import type { Interval } from "./timeIndex";

export interface ChartSettings {
  interval: Interval;
  type: ChartType;
  scale: ScaleMode;
  indicators: IndicatorConfig[];
  showTrades: boolean;
  showPatterns: boolean;
  magnet: boolean;
  stay: boolean;
  /** Last style used per drawing tool. */
  styles: Partial<Record<DrawingType, DrawingStyle>>;
  lastSymbol: string | null;
}

const KEY = "promoter-tracker.chart.v1";
const TYPES: ChartType[] = ["candles", "hollow", "bars", "heikin", "line", "area"];

export const DEFAULT_SETTINGS: ChartSettings = {
  interval: "D",
  type: "candles",
  scale: "linear",
  indicators: [{ id: "volume", kind: "volume", params: [], color: "#8b95a7" }],
  showTrades: true,
  showPatterns: false,
  magnet: false,
  stay: false,
  styles: {},
  lastSymbol: null,
};

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

/** Settings read back from storage, with anything unknown or out of range replaced by defaults. */
export function parseSettings(raw: unknown): ChartSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const indicators = Array.isArray(r.indicators)
    ? r.indicators.flatMap((x): IndicatorConfig[] => {
        const def = INDICATORS.find((i) => i.kind === x?.kind);
        if (!def || typeof x.id !== "string") return [];
        return [{
          id: x.id,
          kind: def.kind,
          params: cleanParams(def.kind, Array.isArray(x.params) ? x.params : []),
          color: isColor(x.color) ? x.color : def.color,
          ...(x.hidden ? { hidden: true } : {}),
        }];
      })
    : d.indicators;
  const styles: ChartSettings["styles"] = {};
  if (r.styles && typeof r.styles === "object") {
    for (const [type, s] of Object.entries(r.styles as Record<string, Partial<DrawingStyle>>)) {
      if (!(DRAWING_TYPES as readonly string[]).includes(type) || !s) continue;
      if (isColor(s.color) && [1, 2, 3, 4].includes(s.width as number) && ["solid", "dashed", "dotted"].includes(s.style as string)) {
        styles[type as DrawingType] = { color: s.color, width: s.width as number, style: s.style as DrawingStyle["style"] };
      }
    }
  }
  return {
    interval: pick(r.interval, ["D", "W", "M"] as const, d.interval),
    type: pick(r.type, TYPES, d.type),
    scale: pick(r.scale, ["linear", "log", "percent"] as const, d.scale),
    indicators,
    showTrades: typeof r.showTrades === "boolean" ? r.showTrades : d.showTrades,
    showPatterns: typeof r.showPatterns === "boolean" ? r.showPatterns : d.showPatterns,
    magnet: r.magnet === true,
    stay: r.stay === true,
    styles,
    lastSymbol: typeof r.lastSymbol === "string" && /^[A-Z0-9&.-]{1,20}$/.test(r.lastSymbol) ? r.lastSymbol : null,
  };
}

export function loadSettings(): ChartSettings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_SETTINGS; // storage blocked (private mode) or corrupt
  }
}

function saveSettings(s: ChartSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked or full: the settings just won't be remembered.
  }
}

export function useChartSettings(): [ChartSettings, (patch: Partial<ChartSettings>) => void] {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => saveSettings(settings), [settings]);
  const update = useCallback((patch: Partial<ChartSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  return [settings, update];
}

/** A new indicator of a kind, with its default settings and a color not already in use. */
export function newIndicator(kind: IndicatorConfig["kind"], existing: IndicatorConfig[]): IndicatorConfig {
  const def = INDICATORS.find((i) => i.kind === kind)!;
  const used = new Set(existing.map((e) => e.color));
  const color = used.has(def.color) ? (PALETTE.find((c) => !used.has(c)) ?? def.color) : def.color;
  return { id: `${kind}-${Date.now().toString(36)}`, kind, params: def.params.map((p) => p.value), color };
}
