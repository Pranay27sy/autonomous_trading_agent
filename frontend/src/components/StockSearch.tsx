import { useId, useMemo, useState } from "react";
import type { StockListItem } from "../api";

/** Type-ahead stock search: symbol or company name, keyboard friendly. */
export function StockSearch(props: {
  stocks: StockListItem[];
  onPick: (stock: StockListItem) => void;
  placeholder: string;
  exclude?: string[];
}) {
  const { stocks, onPick, placeholder, exclude = [] } = props;
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const list = stocks.filter((s) => !exclude.includes(s.symbol));
    return (q ? list.filter((s) => s.symbol.toLowerCase().startsWith(q) || (s.company ?? "").toLowerCase().includes(q)) : list).slice(
      0,
      30,
    );
  }, [stocks, text, exclude]);

  const pick = (s: StockListItem | undefined) => {
    if (!s) return;
    setText("");
    setOpen(false);
    onPick(s);
  };

  return (
    <div className="picker">
      <input
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Find a stock"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, matches.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter") pick(matches[active]);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
      />
      {open && matches.length > 0 && (
        <ul className="picker-list" id={listId} role="listbox">
          {matches.map((s, i) => (
            <li key={s.symbol} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={() => pick(s)}>
              <span className="sym">{s.symbol}</span>
              <span className="muted">{s.company}</span>
              {s.trades > 0 && <span className="count">{s.trades}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
