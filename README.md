# autonomous_trading_agent

## Promoter Trades Analyzer

A local Streamlit app that shows promoter buying and selling in NSE-listed stocks
and what the share price did afterwards.

- **Recent trades:** every promoter / promoter-group buy and sell, with value,
  change in holding %, and the returns that followed. It also flags *clusters*,
  where several promoters bought the same stock within a few days.
- **Stock drill-down:** price chart with buy/sell markers (sized by value) and
  per-trade returns at +1/+5/+20/+60/+120 trading days, both raw and relative to Nifty 50.
- **Does it work?:** average excess return vs Nifty and hit rate after promoter buys
  vs sells, plus the top net promoter buyers and sellers.

### Data (all free)
| What | Source |
|---|---|
| Insider / promoter trades | NSE SEBI PIT disclosures: `/api/corporates-pit` up to 2 May 2026, then `/api/corporates-pit-gg` plus each filing's XBRL file |
| Daily prices | Yahoo Finance via `yfinance` (`SYMBOL.NS`, `^NSEI` benchmark) |

Everything is cached in `data/promoter.db` (SQLite). Refreshes are incremental:
only disclosures since the last one (with a 7-day overlap for late filings) and
only new price bars are downloaded. Disclosures are saved one 30-day chunk at a time,
filings whose XBRL file failed to download are retried on the next refresh, and a
revised filing replaces the original's rows. The app refreshes itself when the cache is
more than 6 hours old, and there's a **Refresh latest data** button.

### Run
```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
streamlit run promoter_tracker/app.py
```
The first load pulls the last 365 days of disclosures (you can change this in the sidebar),
then prices for every stock with a promoter trade. This takes a few minutes.

To refresh on a schedule without opening the app (e.g. cron at 7 pm IST on weekdays):
```bash
python -m promoter_tracker.refresh --backfill-days 730
```

Environment variables: `PROMOTER_DB` (SQLite path), `PROMOTER_AUTO_REFRESH=0` (turn off auto-refresh).

### How returns are measured
- The event date defaults to the **disclosure date**, the first day the public could act.
  You can switch it to the promoter's trade date in the sidebar.
- Entry is the close of the **first trading day after** the event date. Many
  disclosures land after market hours, so this is the conservative choice.
- Excess return = stock return minus Nifty 50 return over the same days.
- "Open-market trades only" (the default) keeps Market Purchase / Market Sale and drops
  gifts, off-market transfers, ESOPs, pledges and similar non-signal entries.

### Caveats
- The NSE and Yahoo endpoints are unofficial and rate-limited, and they may change or block
  requests. If NSE renames JSON fields, update `FIELD_ALIASES` in `promoter_tracker/nse_client.py`.
  If a refresh warns that NSE returned no disclosures for a couple of weeks, the feed has
  probably moved again: check which endpoint NSE's insider-trading page now calls.
- Disclosures can lag the actual trade by up to about 4 trading days.
- Survivorship: delisted stocks have no Yahoo prices and are skipped.
- For research only, not investment advice.

### Tests
```bash
pytest
```
