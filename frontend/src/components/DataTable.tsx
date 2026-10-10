import { useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  label: string;
  /** Cell content; defaults to the raw value. */
  render?: (row: T) => ReactNode;
  /** Value used for sorting; defaults to row[key]. Return null to sort last. */
  sortValue?: (row: T) => number | string | null;
  align?: "left" | "right";
  className?: string;
  title?: string;
}

/** A sortable table with client-side pagination. */
export function DataTable<T>(props: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, index: number) => string;
  pageSize?: number;
  tall?: boolean;
  initialSort?: { key: string; desc: boolean };
}) {
  const { rows, columns, rowKey, pageSize, tall } = props;
  const [sort, setSort] = useState(props.initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue ?? ((r: T) => (r as Record<string, unknown>)[col.key] as number | string | null);
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // missing values always last
      if (vb == null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, columns, sort]);

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const visible = pageSize ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted;

  const toggle = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? (s.desc ? { key, desc: false } : null) : { key, desc: true }));
  };

  return (
    <>
      <div className={`table-wrap ${tall ? "tall" : ""}`}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`sortable ${c.align === "right" ? "num" : ""}`}
                  title={c.title}
                  aria-sort={sort?.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}
                  onClick={() => toggle(c.key)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(c.key))}
                  tabIndex={0}
                  scope="col"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={rowKey(row, i)}>
                {columns.map((c) => (
                  <td key={c.key} className={`${c.align === "right" ? "num" : ""} ${c.className ?? ""}`}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "–")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageSize && sorted.length > pageSize && (
        <div className="pager">
          <span>
            {current * pageSize + 1}–{Math.min((current + 1) * pageSize, sorted.length)} of{" "}
            {sorted.length.toLocaleString("en-IN")}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button className="btn" type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
              ← Prev
            </button>
            <button className="btn" type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next →
            </button>
          </span>
        </div>
      )}
    </>
  );
}
