import type { Trade } from "./api";
import type { Column } from "./components/DataTable";
import { ConvictionBadge, SideChip, StockLink } from "./components/ui";
import { day, inr, integer, pct, percentPoints, signClass } from "./format";

type ReturnKey = `ret_${1 | 5 | 20 | 60 | 120}` | `exc_${1 | 5 | 20 | 60 | 120}`;

const returnColumn = (key: ReturnKey): Column<Trade> => {
  const [kind, h] = key.split("_");
  return {
    key,
    label: kind === "ret" ? `+${h}d` : `+${h}d vs N50`,
    title: kind === "ret" ? `Stock return ${h} trading days after entry` : `Return minus Nifty 50's over the same ${h} days`,
    align: "right",
    render: (t) => <span className={signClass(t[key])}>{pct(t[key])}</span>,
  };
};

const all: Record<string, Column<Trade>> = {
  event_date: { key: "event_date", label: "Date", render: (t) => day(t.event_date) },
  symbol: { key: "symbol", label: "Symbol", render: (t) => <StockLink symbol={t.symbol} /> },
  direction: {
    key: "direction",
    label: "Side",
    render: (t) => (
      <span style={{ display: "inline-flex", gap: 4 }}>
        <SideChip side={t.direction} />
        {t.internal_transfer && (
          <span className="chip neutral" title="A promoter-group member trading with another on the same day">
            transfer
          </span>
        )}
      </span>
    ),
  },
  company: { key: "company", label: "Company", className: "clip", render: (t) => <span className="muted" title={t.company ?? ""}>{t.company}</span> },
  person: { key: "person", label: "Promoter", className: "clip", render: (t) => <span title={t.person ?? ""}>{t.person}</span> },
  mode: { key: "mode", label: "Mode", render: (t) => <span className="muted">{t.mode}</span> },
  value: { key: "value", label: "Value", align: "right", render: (t) => inr(t.value) },
  conviction: {
    key: "conviction",
    label: "Conviction",
    title:
      "0–100 score for promoter buys: stake bought, size vs trading volume, other promoters buying, price dip, repeat buying. Hover a score for its reasons.",
    render: (t) => <ConvictionBadge score={t.conviction} reasons={t.conviction_reasons} />,
  },
  quantity: { key: "quantity", label: "Shares", align: "right", render: (t) => integer(t.quantity) },
  holding_after_pct: {
    key: "holding_after_pct",
    label: "Holding %",
    align: "right",
    title: "This person's holding after the trade",
    render: (t) => percentPoints(t.holding_after_pct),
  },
  holding_change_pct: {
    key: "holding_change_pct",
    label: "Δ hold",
    align: "right",
    title: "Change in holding, percentage points",
    render: (t) => <span className={signClass(t.holding_change_pct)}>{percentPoints(t.holding_change_pct, 2, true)}</span>,
  },
};

export function tradeColumns(keys: (keyof typeof all | ReturnKey)[]): Column<Trade>[] {
  return keys.map((k) => all[k] ?? returnColumn(k as ReturnKey));
}

export const ALL_RETURNS: ReturnKey[] = ["ret_1", "ret_5", "ret_20", "ret_60", "ret_120", "exc_5", "exc_20", "exc_60", "exc_120"];
export const KEY_RETURNS: ReturnKey[] = ["ret_5", "ret_20", "exc_20", "ret_60", "exc_60"];

/** CSV of trades for download (values unformatted, returns as fractions). */
export function tradesCsv(rows: Trade[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!) as (keyof Trade)[];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
