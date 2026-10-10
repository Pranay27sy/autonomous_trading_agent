# autonomous_trading_agent

## Promoter Trades Analyzer

A web app that shows promoter buying and selling in NSE-listed stocks and what the share
price did afterwards. A FastAPI backend serves JSON and a React + TypeScript frontend, in a
dark trading-terminal style. Its main pages:

- **Overview:** promoter buying, selling and net flow with weekly sparklines. Then the
  key question, *does promoter buying beat the market?*: average return vs Nifty and how
  often it beat Nifty after promoter buys vs sells. Also *buying clusters* (several
  promoters buying the same stock within a few weeks) and the top net buyers and sellers.
- **Trades:** every promoter / promoter-group buy and sell, searchable, with value, change
  in holding %, and the returns that followed (green/red).
- **Stock:** price chart with buy ▲ / sell ▼ markers sized by rupee value, and per-trade
  returns at +1/+5/+20/+60/+120 trading days, raw and relative to Nifty 50. The selected
  stock is in the URL, so links can be shared.

### Watchlist and alerts
Click **☆ Watch** on a stock to add it to your watchlist. After every refresh, the app checks
the newly arrived promoter trades and raises an alert for:
- any promoter trade in a watched stock;
- a large promoter buy (default ₹5 cr) or sell (default ₹25 cr) in any stock;
- a buying cluster: several promoters (default 3) buying the same stock within 30 days.

Several trades of one kind in one stock become a single alert, and a cluster alert replaces
that stock's large-buy alerts. Alerts show under the bell in the top bar and on the **Alerts**
page, where you can change the rules. Only trades that arrive after the feature is first
switched on raise alerts, so your existing history doesn't.

To also get each refresh's alerts as one Telegram message and/or email, set the variables in
[`.env.example`](.env.example) (copy it to `.env` for Docker) and restart. Secrets are read from
the environment only. They are never stored in the database or sent to the browser, and the
Alerts page has a **Send a test alert** button.

Click any symbol in a table to open its stock page. The filter bar (period, side, minimum
value, open-market only, and the date returns are measured from) applies to every page and
is kept in the URL, so any view can be bookmarked or shared. The data menu at the top right
shows how fresh the data is, lets you start a refresh, and shows its progress.

### Layout
| Path | What |
|---|---|
| `promoter_tracker/` | Python: NSE client, prices, SQLite store, analysis, refresh CLI |
| `promoter_tracker/api.py` | FastAPI app: JSON under `/api`, serves the built frontend at `/` |
| `promoter_tracker/service.py` | Filtering and response shaping for the API (plain pandas) |
| `frontend/` | React + TypeScript (Vite), TanStack Query, TradingView Lightweight Charts |

### Data (all free)
| What | Source |
|---|---|
| Insider / promoter trades | NSE SEBI PIT disclosures: `/api/corporates-pit` up to 2 May 2026, then `/api/corporates-pit-gg` plus each filing's XBRL file |
| Daily prices | Yahoo Finance via `yfinance` (`SYMBOL.NS`, `^NSEI` benchmark) |

Everything is cached in `data/promoter.db` (SQLite). Refreshes are incremental:
only disclosures since the last one (with a 7-day overlap for late filings) and
only new price bars are downloaded. Disclosures are saved one 30-day chunk at a time,
filings whose XBRL file failed to download are retried on the next refresh, and a
revised filing replaces the original's rows. When the server starts with data more than
6 hours old it refreshes in the background, and you can start one from the data menu.

### Run
```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cd frontend && npm ci && npm run build && cd ..
uvicorn promoter_tracker.api:app --port 8000        # open http://localhost:8000
```
Needs Python 3.10+ and Node 20+. On the first start the server pulls the last 365 days of
disclosures, then prices for every stock with a promoter trade, in the background. This
takes a few minutes; the data menu shows progress. API docs are at
http://localhost:8000/api/docs.

For frontend work, run the API with `--reload` and, in another terminal, `npm run dev` in
`frontend/`. Vite serves the UI on http://localhost:5173 with hot reload and proxies `/api`
to port 8000.

To refresh on a schedule without opening the app (e.g. cron at 7 pm IST on weekdays):
```bash
promoter-refresh --backfill-days 730      # same as: python -m promoter_tracker.refresh
```
It exits 0 on success, 1 if the refresh had errors, and 75 if another refresh (the app or
another cron run) was already running, so a scheduler can alert on failures. Add
`--every-hours 6` to keep it running and refreshing instead of exiting.

Only one refresh runs at a time across all processes (a lock file next to the database),
and the database runs in SQLite WAL mode, so the app keeps serving while a refresh writes.

### Deploy with Docker
```bash
docker compose up -d --build
```
This builds the frontend and starts the app on port 8000, plus a `refresher` container that
updates the data every 6 hours. Both share the `promoter-data` volume. The app's own
auto-refresh is turned off there. The image runs as a non-root user and has a health check
on `/api/health`. Refresh logs go to `/data/logs/refresh.log` in the volume.

The app has no login. Put it behind a reverse proxy with authentication before you expose it
beyond your own machine or network.

### Configuration
| Variable | Default | Meaning |
|---|---|---|
| `PROMOTER_DB` | `data/promoter.db` | SQLite path |
| `PROMOTER_AUTO_REFRESH` | `1` | `0` stops the server refreshing stale data when it starts |
| `PROMOTER_STALE_HOURS` | `6` | How old the data must be to count as stale |
| `PROMOTER_LOG_LEVEL` | `INFO` | Logging level |
| `PROMOTER_LOG_FILE` | none | Also log to this file (rotated at 5 MB, 3 kept) |
| `PROMOTER_FRONTEND_DIST` | `frontend/dist` | Built frontend to serve at `/` |
| `PROMOTER_PUBLIC_URL` | none | App URL, used for links in alert messages |
| `PROMOTER_TELEGRAM_BOT_TOKEN`, `PROMOTER_TELEGRAM_CHAT_ID` | none | Send alerts to Telegram |
| `PROMOTER_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_FROM`, `PROMOTER_ALERT_EMAIL_TO` | none | Send alerts by email (comma-separated recipients) |

### How returns are measured
- The event date defaults to the **disclosure date**, the first day the public could act.
  You can switch it to the promoter's trade date in the filter bar.
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

### Tests and lint
```bash
pytest && ruff check .
cd frontend && npm run typecheck && npm test
```
CI (GitHub Actions) runs the Python checks on 3.10, 3.12 and 3.13, typechecks, tests, builds
and audits the frontend, and builds the Docker image.
