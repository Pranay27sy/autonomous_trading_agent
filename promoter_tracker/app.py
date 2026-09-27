"""Streamlit UI: promoter buying/selling on NSE and what the price did next.

Run:  streamlit run promoter_tracker/app.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from promoter_tracker import analysis  # noqa: E402
from promoter_tracker.prices import BENCHMARK, nse_ticker  # noqa: E402
from promoter_tracker.refresh import refresh_all  # noqa: E402
from promoter_tracker.store import DEFAULT_DB, Store  # noqa: E402

STALE_AFTER = timedelta(hours=6)
DB_PATH = os.environ.get("PROMOTER_DB", str(DEFAULT_DB))
AUTO_REFRESH = os.environ.get("PROMOTER_AUTO_REFRESH", "1") != "0"

st.set_page_config(page_title="Promoter Trades", page_icon="📈", layout="wide")


@st.cache_resource
def get_store() -> Store:
    return Store(DB_PATH)


store = get_store()


def last_refresh() -> datetime | None:
    raw = store.get_meta("last_refresh")
    return datetime.fromisoformat(raw) if raw else None


def run_refresh(backfill_days: int) -> None:
    with st.status("Pulling latest data…", expanded=True) as status:
        res = refresh_all(store, backfill_days, progress=status.write)
        msg = f"{res.new_trades} new disclosures, {res.price_rows} price rows"
        if res.errors:
            status.update(label=f"Refresh finished with errors ({msg})", state="error")
            for e in res.errors:
                st.error(e)
        else:
            status.update(label=f"Up to date: {msg}", state="complete")
        for w in res.warnings:
            st.warning(w)
    st.cache_data.clear()


@st.cache_data(show_spinner=False)
def load_events(market_only: bool, event_basis: str, _version: str) -> pd.DataFrame:
    events = analysis.promoter_events(store.load_trades(), market_only, event_basis)
    if events.empty:
        return events
    bench = store.load_prices(BENCHMARK)
    return analysis.event_returns(events, lambda s: store.load_prices(nse_ticker(s)), bench)


# --- sidebar --------------------------------------------------------------
st.sidebar.title("📈 Promoter Trades")
lr = last_refresh()
st.sidebar.caption(
    f"Last refresh: {lr.astimezone().strftime('%d %b %Y %H:%M') if lr else 'never'}"
)
backfill = st.sidebar.number_input("History on first load (days)", 30, 3650, 365, 30)
if st.sidebar.button("🔄 Refresh latest data", use_container_width=True):
    run_refresh(int(backfill))
    lr = last_refresh()
elif AUTO_REFRESH and "auto_refreshed" not in st.session_state and (
    lr is None or datetime.now(timezone.utc) - lr > STALE_AFTER
):
    st.session_state["auto_refreshed"] = True
    run_refresh(int(backfill))
    lr = last_refresh()

st.sidebar.divider()
market_only = st.sidebar.toggle("Open-market trades only", True,
                                help="Drop gifts, off-market transfers, ESOPs, pledges, etc.")
event_basis = st.sidebar.radio(
    "Measure returns from", ["disclosure_date", "trade_to"],
    format_func={"disclosure_date": "Disclosure date (tradable)",
                 "trade_to": "Trade date (promoter's)"}.get,
)

events = load_events(market_only, event_basis, str(lr))

if events.empty:
    st.title("Promoter buying & selling")
    st.info("No promoter trades cached yet. Click **Refresh latest data** in the sidebar.")
    st.stop()

min_d, max_d = events["event_date"].min().date(), events["event_date"].max().date()
date_range = st.sidebar.date_input("Event dates", (max(min_d, max_d - timedelta(days=365)), max_d),
                                   min_value=min_d, max_value=max_d)
directions = st.sidebar.multiselect("Direction", ["buy", "sell"], ["buy", "sell"])
min_value_lakh = st.sidebar.number_input("Min trade value (₹ lakh)", 0.0, value=10.0, step=5.0)

if isinstance(date_range, tuple) and len(date_range) == 2:
    d0, d1 = pd.Timestamp(date_range[0]), pd.Timestamp(date_range[1])
else:
    d0, d1 = pd.Timestamp(min_d), pd.Timestamp(max_d)
view = events[
    events["event_date"].between(d0, d1)
    & events["direction"].isin(directions)
    & (events["value"].fillna(0) >= min_value_lakh * 1e5)
]

st.title("Promoter buying & selling")
c1, c2, c3, c4 = st.columns(4)
c1.metric("Promoter trades", f"{len(view):,}")
for col, direction in ((c2, "buy"), (c3, "sell")):
    d = view[view["direction"] == direction]
    col.metric(f"{direction.title()}s · ₹{d['value'].sum() / 1e7:,.1f} cr", f"{len(d):,}")
c4.metric("Stocks", f"{view['symbol'].nunique():,}")

tab_recent, tab_stock, tab_stats = st.tabs(
    ["Recent trades", "Stock drill-down", "Does it work?"])

def pct_cols(df: pd.DataFrame, cols) -> pd.DataFrame:
    df = df.copy()
    for c in cols:
        df[c] = df[c] * 100
    return df


# --- recent trades --------------------------------------------------------
with tab_recent:
    table = view[["event_date", "symbol", "company", "person", "direction", "mode",
                  "quantity", "value", "holding_before_pct", "holding_after_pct",
                  "holding_change_pct", "ret_5", "ret_20", "exc_20", "ret_60"]]
    table = pct_cols(table, ["ret_5", "ret_20", "exc_20", "ret_60"])
    table = table.assign(value=table["value"] / 1e5)
    st.dataframe(
        table, hide_index=True, use_container_width=True, height=560,
        column_config={
            "event_date": st.column_config.DateColumn("Date"),
            "value": st.column_config.NumberColumn("Value (₹ lakh)", format="%.1f"),
            "quantity": st.column_config.NumberColumn("Qty", format="%d"),
            "holding_before_pct": st.column_config.NumberColumn("Hold before %", format="%.2f"),
            "holding_after_pct": st.column_config.NumberColumn("Hold after %", format="%.2f"),
            "holding_change_pct": st.column_config.NumberColumn("Δ hold %", format="%+.2f"),
            "ret_5": st.column_config.NumberColumn("+5d", format="%.1f%%"),
            "ret_20": st.column_config.NumberColumn("+20d", format="%.1f%%"),
            "exc_20": st.column_config.NumberColumn("+20d vs Nifty", format="%.1f%%"),
            "ret_60": st.column_config.NumberColumn("+60d", format="%.1f%%"),
        },
    )
    st.subheader("Promoter buying clusters")
    cc1, cc2 = st.columns(2)
    min_people = cc1.slider("Distinct promoters", 2, 6, 2)
    window = cc2.slider("Within days", 5, 90, 30)
    cl = analysis.clusters(view, min_people, window)
    if cl.empty:
        st.caption("No clusters for the current filters.")
    else:
        st.dataframe(cl.assign(total_value=cl["total_value"] / 1e5), hide_index=True,
                     use_container_width=True,
                     column_config={"total_value": st.column_config.NumberColumn(
                         "Value (₹ lakh)", format="%.1f")})

# --- stock drill-down -----------------------------------------------------
with tab_stock:
    counts = view.groupby("symbol").size().sort_values(ascending=False)
    if counts.empty:
        st.info("No trades match the filters.")
    else:
        symbol = st.selectbox(
            "Stock", counts.index,
            format_func=lambda s: f"{s} — {view.loc[view['symbol'] == s, 'company'].iloc[0]}"
                                  f" ({counts[s]} trades in range)")
        # Show the stock's whole promoter history for context, not just the date range.
        sev = events[(events["symbol"] == symbol) & events["direction"].isin(directions)]
        st.caption(f"Chart and table show all {len(sev)} promoter trades in {symbol} "
                   "across the cached history.")
        px = store.load_prices(nse_ticker(symbol))
        if px.empty:
            st.warning(f"No price data cached for {nse_ticker(symbol)}. Try refreshing.")
        else:
            lo = min(sev["event_date"].min(), d0) - pd.Timedelta(days=60)
            px = px[px.index >= lo]
            fig = go.Figure(go.Scatter(x=px.index, y=px.values, name="Close",
                                       line=dict(color="#7f8c9a", width=1.6)))
            for direction, color, symbol_shape in (("buy", "#16a34a", "triangle-up"),
                                                   ("sell", "#dc2626", "triangle-down")):
                d = sev[sev["direction"] == direction]
                if d.empty:
                    continue
                y = [px.asof(t) for t in d["event_date"]]
                size = 8 + 22 * (d["value"].fillna(0) / max(sev["value"].max() or 1, 1)) ** 0.5
                fig.add_trace(go.Scatter(
                    x=d["event_date"], y=y, mode="markers", name=direction.title(),
                    marker=dict(color=color, size=size, symbol=symbol_shape,
                                line=dict(width=1, color="white")),
                    customdata=d[["person", "value", "quantity"]].assign(
                        value=d["value"] / 1e5).to_numpy(),
                    hovertemplate="%{x|%d %b %Y}<br>%{customdata[0]}<br>"
                                  "₹%{customdata[1]:,.1f} lakh · %{customdata[2]:,.0f} sh"
                                  "<extra>" + direction + "</extra>"))
            fig.update_layout(height=460, margin=dict(l=10, r=10, t=30, b=10),
                              legend=dict(orientation="h", y=1.08), hovermode="closest",
                              yaxis_title="Price (₹)")
            st.plotly_chart(fig, use_container_width=True)
        cols = ["event_date", "person", "direction", "mode", "value", "holding_after_pct"] + \
               [f"ret_{h}" for h in analysis.HORIZONS] + [f"exc_{h}" for h in analysis.HORIZONS]
        st.dataframe(pct_cols(sev[cols], cols[6:]).assign(value=sev["value"] / 1e5),
                     hide_index=True, use_container_width=True,
                     column_config={**{f"ret_{h}": st.column_config.NumberColumn(
                                        f"+{h}d", format="%.1f%%") for h in analysis.HORIZONS},
                                    **{f"exc_{h}": st.column_config.NumberColumn(
                                        f"+{h}d vs Nifty", format="%.1f%%")
                                       for h in analysis.HORIZONS},
                                    "holding_after_pct": st.column_config.NumberColumn(
                                        "Hold after %", format="%.2f"),
                                    "event_date": st.column_config.DateColumn("Date"),
                                    "value": st.column_config.NumberColumn(
                                        "Value (₹ lakh)", format="%.1f")})

# --- stats ----------------------------------------------------------------
with tab_stats:
    summ = analysis.summarize(view)
    if summ.empty or summ["events"].sum() == 0:
        st.info("Not enough price history after these events yet.")
    else:
        st.caption("Entry = close of the first trading day after the event date. "
                   "Excess = stock return minus Nifty 50 over the same days.")
        fig = go.Figure()
        for direction, color in (("buy", "#16a34a"), ("sell", "#dc2626")):
            d = summ[summ["direction"] == direction]
            if d.empty:
                continue
            fig.add_trace(go.Scatter(
                x=d["horizon_days"], y=d["mean_excess"] * 100, mode="lines+markers",
                name=f"After promoter {direction}s", line=dict(color=color, width=2.5),
                customdata=d[["events", "hit_rate"]].to_numpy(),
                hovertemplate="+%{x}d: %{y:.2f}% vs Nifty<br>n=%{customdata[0]}, "
                              "beat Nifty %{customdata[1]:.0%}<extra></extra>"))
        fig.add_hline(y=0, line_color="#9ca3af", line_dash="dot")
        fig.update_layout(height=380, xaxis_title="Trading days after event",
                          yaxis_title="Mean excess return vs Nifty (%)",
                          xaxis=dict(tickvals=list(analysis.HORIZONS)),
                          margin=dict(l=10, r=10, t=30, b=10),
                          legend=dict(orientation="h", y=1.1))
        st.plotly_chart(fig, use_container_width=True)
        st.dataframe(
            pct_cols(summ, ["mean_return", "median_return", "mean_excess", "hit_rate"]),
            hide_index=True, use_container_width=True,
            column_config={"horizon_days": st.column_config.NumberColumn("Days after"),
                           "mean_return": st.column_config.NumberColumn("Mean return", format="%.1f%%"),
                           "median_return": st.column_config.NumberColumn("Median return", format="%.1f%%"),
                           "mean_excess": st.column_config.NumberColumn("Mean vs Nifty", format="%.1f%%"),
                           "hit_rate": st.column_config.NumberColumn(
                               "Beat Nifty", format="%.0f%%")})

    st.subheader("Net promoter buying by stock")
    lb = analysis.leaderboard(view)
    lb = lb.assign(net_value=lb["net_value"] / 1e7)
    fmt = {"net_value": st.column_config.NumberColumn("Net (₹ cr)", format="%+.2f")}
    l1, l2 = st.columns(2)
    l1.caption("Top net buyers")
    l1.dataframe(lb.head(15), hide_index=True, use_container_width=True, column_config=fmt)
    l2.caption("Top net sellers")
    l2.dataframe(lb.tail(15).iloc[::-1], hide_index=True, use_container_width=True,
                 column_config=fmt)

st.caption("Data: NSE insider-trading (SEBI PIT) disclosures and Yahoo Finance prices, "
           "both unofficial free sources. Disclosures can lag trades by ~4 trading days. "
           "For research only, not investment advice.")
