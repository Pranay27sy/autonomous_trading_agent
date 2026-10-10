import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "../components/DataTable";

afterEach(cleanup);

const rows = [
  { sym: "B", v: 2 },
  { sym: "A", v: null },
  { sym: "C", v: 5 },
];
const cols = [
  { key: "sym", label: "Symbol" },
  { key: "v", label: "Value", align: "right" as const },
];
const order = () => screen.getAllByRole("row").slice(1).map((r) => r.firstChild!.textContent);

describe("DataTable", () => {
  it("sorts descending then ascending, with missing values last", () => {
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.sym} />);
    expect(order()).toEqual(["B", "A", "C"]);
    fireEvent.click(screen.getByText("Value"));
    expect(order()).toEqual(["C", "B", "A"]);
    fireEvent.click(screen.getByText("Value"));
    expect(order()).toEqual(["B", "C", "A"]);
  });

  it("paginates", () => {
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.sym} pageSize={2} />);
    expect(order()).toEqual(["B", "A"]);
    fireEvent.click(screen.getByText("Next →"));
    expect(order()).toEqual(["C"]);
    expect(screen.getByText(/3–3 of 3/)).toBeTruthy();
  });
});
