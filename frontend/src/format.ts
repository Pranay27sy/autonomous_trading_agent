// Number and date formatting, Indian conventions: ₹ crore (1e7) and lakh (1e5).

const MINUS = "−";

/** ₹ in crore, or lakh below ₹1 cr: ₹1,204 cr, ₹45.2 L. */
export function inr(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const sign = value < 0 ? MINUS : signed && value > 0 ? "+" : "";
  const v = Math.abs(value);
  if (v >= 1e9) return `${sign}₹${group(v / 1e7, 0)} cr`;
  if (v >= 1e7) return `${sign}₹${group(v / 1e7, 1)} cr`;
  if (v === 0) return "₹0";
  return `${sign}₹${group(v / 1e5, 1)} L`;
}

/** A fraction as a signed percent: 0.0512 -> +5.1%. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const s = (Math.abs(value) * 100).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${value > 0 ? "+" : MINUS}${s}%`;
}

/** Plain percent of a value already in percent units: 45.2 -> 45.20%. */
export function percentPoints(value: number | null | undefined, digits = 2, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const sign = value < 0 ? MINUS : signed && value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

export function integer(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  return group(value, 0);
}

export function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  return `₹${group(value, 2)}`;
}

function group(value: number, digits: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-01-05" -> "05 Jan 2024" (or "05 Jan 24" when short). */
export function day(iso: string | null | undefined, short = false): string {
  if (!iso) return "–";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[Number(m) - 1] ?? m} ${short ? y.slice(2) : y}`;
}

export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const secs = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  const days = Math.floor(secs / 86400);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

export function signClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "pos" : "neg";
}
