"""HTTP API (FastAPI) and the built web frontend, served from one process.

Run:  uvicorn promoter_tracker.api:app --port 8000
The React frontend in frontend/ is built into frontend/dist and served at /
($PROMOTER_FRONTEND_DIST overrides where); everything under /api is JSON, and
the interactive API docs are at /api/docs.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated, Literal

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi import Path as PathParam
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import alerts as alert_rules
from . import analysis, notify, patterns, pledges, research, screener, service
from .config import Settings, configure_logging, load_settings
from .prices import BENCHMARK, nse_ticker
from .refresh import RefreshInProgress, refresh_all
from .store import Store

log = logging.getLogger(__name__)

_FROM_SETTINGS = Path("<settings>")
SYMBOL_RE = re.compile(r"^[A-Z0-9&.\-]{1,20}$")
PATTERN_FIELDS = ["symbol", "pattern", "name", "direction", "start", "breakout",
                  "breakout_price", "level", "target", "volume_ratio", "points", "line",
                  "promoter_buys", "promoter_net_value", "promoter_buying",
                  "signed_5", "signed_20", "signed_60"]
COMPARE_RE = r"^[A-Za-z0-9&.\-]{1,20}(,[A-Za-z0-9&.\-]{1,20}){0,3}$"  # 1-4 symbols
TEST_ALERT_COOLDOWN = 30  # seconds between test messages
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class AlertSettingsBody(BaseModel):
    watchlist_trades: bool = True
    big_buy_value: float | None = Field(default=5e7, ge=0, le=1e12)
    big_sell_value: float | None = Field(default=2.5e8, ge=0, le=1e12)
    cluster_min_people: int | None = Field(default=3, ge=2, le=10)
    cluster_window_days: int = Field(default=30, ge=1, le=365)
    market_only: bool = True
    min_conviction: int | None = Field(default=None, ge=0, le=100)
    pledge_invocations: bool = True
    pattern_watchlist: bool = True
    pattern_promoter: bool = False


class CriteriaBody(BaseModel):
    lookback_days: int = Field(default=90, ge=7, le=1095)
    min_net_value: float | None = Field(default=None, ge=-1e13, le=1e13)
    min_buys: int | None = Field(default=None, ge=0, le=1000)
    min_promoters: int | None = Field(default=None, ge=0, le=100)
    min_conviction: int | None = Field(default=None, ge=0, le=100)
    min_below_high: float | None = Field(default=None, ge=0, le=1)
    max_change_3m: float | None = Field(default=None, ge=-1, le=10)
    sectors: list[str] = Field(default_factory=list, max_length=50)
    caps: list[str] = Field(default_factory=list, max_length=10)
    exclude_pledge_risk: bool = False
    sort: Literal["net_value", "conviction", "below_high", "promoters", "change_3m"] = "net_value"


class ScreenBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    criteria: CriteriaBody
    alert: bool = False


class MarkRead(BaseModel):
    ids: list[int] | None = Field(default=None, max_length=1000)  # None marks all read


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RefreshManager:
    """Runs one refresh at a time in a background thread and keeps its progress.

    refresh_all also holds a file lock, so a refresh started by the scheduled CLI
    makes this one end with "already running" instead of running twice.
    """

    def __init__(self, store: Store, on_done=lambda: None):
        self.store = store
        self.on_done = on_done
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.state = "idle"  # idle | running | done | error | busy
        self.started_at: datetime | None = None
        self.finished_at: datetime | None = None
        self.log: deque[str] = deque(maxlen=40)
        self.result: dict | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, backfill_days: int) -> bool:
        with self._lock:
            if self.running:
                return False
            self.state, self.started_at, self.finished_at = "running", _now(), None
            self.log.clear()
            self.result = None
            self._thread = threading.Thread(target=self._run, args=(backfill_days,),
                                            name="refresh", daemon=True)
            self._thread.start()
            return True

    def _run(self, backfill_days: int) -> None:
        try:
            res = refresh_all(self.store, backfill_days, progress=self.log.append)
            self.result = {"new_trades": res.new_trades, "price_rows": res.price_rows,
                           "errors": res.errors, "warnings": res.warnings}
            self.state = "error" if res.errors else "done"
        except RefreshInProgress:
            self.state = "busy"
            self.log.append("Another refresh (the scheduled job?) is already running.")
        except Exception as err:  # keep the server up; report it to the UI
            log.exception("Refresh failed")
            self.state = "error"
            self.result = {"new_trades": 0, "price_rows": 0, "errors": [str(err)], "warnings": []}
        finally:
            self.finished_at = _now()
            self.on_done()

    def status(self) -> dict:
        return {"state": self.state, "running": self.running,
                "started_at": self.started_at.isoformat() if self.started_at else None,
                "finished_at": self.finished_at.isoformat() if self.finished_at else None,
                "log": list(self.log), "result": self.result}


def _meta_time(store: Store, key: str) -> datetime | None:
    raw = store.get_meta(key)
    return datetime.fromisoformat(raw) if raw else None


def is_stale(store: Store, settings: Settings) -> bool:
    # Count failed attempts too, or a refresh with errors would rerun on every start.
    times = [t for t in (_meta_time(store, "last_refresh"),
                         _meta_time(store, "last_refresh_attempt")) if t]
    return not times or _now() - max(times) > settings.stale_after


def filters(
    period: Literal["1M", "3M", "6M", "1Y", "3Y", "All"] = "1Y",
    sides: Annotated[str, Query(pattern=r"^(buy|sell)?(,(buy|sell))?$")] = "buy,sell",
    min_value: Annotated[float, Query(ge=0, le=1e12)] = 1e6,
    market_only: bool = True,
    basis: Literal["disclosure_date", "trade_to"] = "disclosure_date",
    include_transfers: bool = False,
) -> service.Filters:
    """The filter bar's query parameters, shared by the data endpoints."""
    return service.Filters(period, tuple(s for s in sides.split(",") if s), min_value,
                           market_only, basis, exclude_transfers=not include_transfers)


# Module level so FastAPI can resolve it (annotations are strings here).
F = Annotated[service.Filters, Depends(filters)]


def create_app(settings: Settings | None = None,
               frontend_dist: Path | None = _FROM_SETTINGS) -> FastAPI:
    """frontend_dist: built frontend to serve (None for API only); defaults to settings."""
    settings = settings or load_settings()
    if frontend_dist == _FROM_SETTINGS:
        frontend_dist = settings.frontend_dist
    configure_logging(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = Store(settings.db_path)
        app.state.store = store
        app.state.events = service.EventCache(store)
        app.state.refresh = RefreshManager(store)
        if settings.auto_refresh and is_stale(store, settings):
            log.info("Data is stale; starting a background refresh")
            app.state.refresh.start(365)
        # Computing returns takes seconds on a full database; do the default view now
        # so the first page load doesn't wait for it.
        def warm():
            app.state.events.get(True, "disclosure_date")
            pattern_data(SimpleNamespace(app=app))  # ~20s across all stocks

        threading.Thread(target=warm, name="warm-cache", daemon=True).start()
        yield
        store.close()

    app = FastAPI(title="Promoter tracker", version="0.3.0", lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        # No login, so stop other websites from changing state through the
        # visitor's browser: browsers send Origin on cross-site writes.
        origin = request.headers.get("origin")
        if (request.method in UNSAFE_METHODS and origin
                and origin.split("://", 1)[-1] != request.headers.get("host")):
            return JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        if not request.url.path.startswith("/api/docs"):
            resp.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "frame-ancestors 'none'; base-uri 'self'")
        return resp

    def events_for(request: Request, f: service.Filters):
        events = request.app.state.events.get(f.market_only, f.basis)
        return events, service.filter_events(events, f)

    @app.get("/api/health")
    def health(request: Request) -> dict:
        store: Store = request.app.state.store
        store.get_meta("last_refresh")  # proves the database answers
        return {"status": "ok"}

    @app.get("/api/status")
    def status(request: Request) -> dict:
        store: Store = request.app.state.store
        last = _meta_time(store, "last_refresh")
        attempt = _meta_time(store, "last_refresh_attempt")
        return {"last_refresh": last.isoformat() if last else None,
                # The last attempt, if it is newer than the last success, failed or is running.
                "last_attempt": attempt.isoformat() if attempt else None,
                "stale": last is None or _now() - last > settings.stale_after,
                "failed_filings": len(store.failed_filings()),
                # How recent the cached data actually is (latest disclosure / Nifty close).
                "disclosures_through": store.last_disclosure_date(),
                "prices_through": store.last_price_date(BENCHMARK),
                "unread_alerts": store.unread_alerts(),
                "refresh": request.app.state.refresh.status()}

    @app.post("/api/refresh", status_code=202)
    def start_refresh(request: Request,
                      backfill_days: Annotated[int, Query(ge=30, le=3650)] = 365) -> JSONResponse:
        manager: RefreshManager = request.app.state.refresh
        if not manager.start(backfill_days):
            return JSONResponse(manager.status(), status_code=409)
        return JSONResponse(manager.status(), status_code=202)

    @app.get("/api/overview")
    def overview(request: Request, f: F,
                 min_people: Annotated[int, Query(ge=2, le=10)] = 2,
                 window_days: Annotated[int, Query(ge=1, le=365)] = 30) -> dict:
        _, view = events_for(request, f)
        return service.overview(view, f, min_people, window_days)

    @app.get("/api/trades")
    def trades(request: Request, f: F,
               q: Annotated[str | None, Query(max_length=100)] = None) -> dict:
        _, view = events_for(request, f)
        return service.trades(view, q)

    # --- research -----------------------------------------------------------------
    research_cache: OrderedDict = OrderedDict()
    research_lock = threading.Lock()

    key_locks: dict[tuple, threading.Lock] = {}

    def cached(request: Request, key: tuple, compute):
        """Research results are deterministic until the next refresh; keep the last 32.

        Single-flight: concurrent requests for the same key wait for one computation
        instead of each running it (the pattern scan alone takes ~20s).
        """
        key = (request.app.state.events.version(), *key)
        with research_lock:
            if key in research_cache:
                research_cache.move_to_end(key)
                return research_cache[key]
            lock = key_locks.setdefault(key, threading.Lock())
        with lock:
            with research_lock:
                if key in research_cache:  # computed while we waited
                    return research_cache[key]
            value = compute()
            with research_lock:
                research_cache[key] = value
                key_locks.pop(key, None)
                while len(research_cache) > 32:
                    research_cache.popitem(last=False)
        return value

    def closes_and_bench(request: Request):
        store: Store = request.app.state.store
        return (lambda s: store.load_prices(nse_ticker(s))), store.load_prices(BENCHMARK)

    @app.get("/api/research/backtest")
    def backtest(
        request: Request,
        side: Literal["buy", "sell"] = "buy",
        hold_days: Annotated[int, Query(ge=1, le=250)] = 60,
        min_value: Annotated[float, Query(ge=0, le=1e12)] = 1e6,
        min_conviction: Annotated[int | None, Query(ge=0, le=100)] = None,
        min_stake_pct: Annotated[float | None, Query(ge=0, le=100)] = None,
        sectors: Annotated[str, Query(max_length=500)] = "",
        caps: Annotated[str, Query(max_length=200)] = "",
        start: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
        end: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
        one_per_stock_days: Annotated[int, Query(ge=0, le=365)] = 0,
        market_only: bool = True,
        basis: Literal["disclosure_date", "trade_to"] = "disclosure_date",
    ) -> dict:
        rule = research.Rule(side, hold_days, min_value, min_conviction, min_stake_pct,
                             tuple(s for s in sectors.split(",") if s),
                             tuple(c for c in caps.split(",") if c), start, end, one_per_stock_days)

        def run():
            events = request.app.state.events.get(market_only, basis)
            closes, bench = closes_and_bench(request)
            out = research.backtest(events, closes, bench, rule)
            out["trades"] = out["trades"][:1000]  # newest first
            return service.clean_tree(out)

        return cached(request, ("backtest", rule, market_only, basis), run)

    @app.get("/api/research/event-study")
    def event_study(request: Request, groups: Literal["side", "conviction"] = "side",
                    market_only: bool = True,
                    basis: Literal["disclosure_date", "trade_to"] = "disclosure_date") -> dict:
        def run():
            events = request.app.state.events.get(market_only, basis)
            closes, bench = closes_and_bench(request)
            return research.event_study(events, closes, bench, groups=groups)

        return cached(request, ("event_study", groups, market_only, basis), run)

    def pledge_events(request: Request):
        store: Store = request.app.state.store
        return cached(request, ("pledge_events",), lambda: pledges.pledge_events(
            store.load_trades(), lambda s: store.load_prices(nse_ticker(s))))

    @app.get("/api/pledges")
    def pledge_summary(request: Request,
                       period: Literal["1M", "3M", "6M", "1Y", "3Y", "All"] = "1Y") -> dict:
        events = pledge_events(request)
        if not events.empty and service.PERIODS[period] is not None:
            start = events["event_date"].max() - pd.Timedelta(days=service.PERIODS[period])
            events = events[events["event_date"] >= start]
        info = request.app.state.store.company_info()
        shares = info["shares_outstanding"] if not info.empty else None
        totals = {k: {"events": int((events["kind"] == k).sum()),
                      "value": float(events.loc[events["kind"] == k, "value"].fillna(0).sum()),
                      "companies": int(events.loc[events["kind"] == k, "symbol"].nunique())}
                  for k in pledges.KINDS}
        return service.clean_tree({
            "totals": totals,
            "companies": pledges.summarize(events, shares),
            "events": events.head(300).to_dict("records"),
        })

    # --- screener -------------------------------------------------------------------
    def screen_rows(request: Request, lookback_days: int, market_only: bool, basis: str):
        """Per-stock screener metrics; cached until the next refresh."""
        store: Store = request.app.state.store

        def build():
            events = request.app.state.events.get(market_only, basis)
            pe = pledge_events(request)
            risk = {p["symbol"]: p["risk"] for p in pledges.summarize(pe)} if not pe.empty else {}
            return screener.metrics(events, lambda s: store.load_prices(nse_ticker(s)),
                                    lookback_days, risk)

        return cached(request, ("screen_rows", lookback_days, market_only, basis), build)

    def run_screen(request: Request, c: screener.Criteria, market_only=True,
                   basis="disclosure_date"):
        return screener.screen(screen_rows(request, c.lookback_days, market_only, basis), c)

    @app.get("/api/screener/presets")
    def presets() -> dict:
        return {name: c.to_dict() for name, c in screener.PRESETS.items()}

    @app.post("/api/screener/run")
    def screener_run(request: Request, body: CriteriaBody, market_only: bool = True,
                     basis: Literal["disclosure_date", "trade_to"] = "disclosure_date") -> dict:
        rows = run_screen(request, screener.Criteria.from_dict(body.model_dump()), market_only, basis)
        watched = {w["symbol"] for w in request.app.state.store.watchlist()}
        out = service.clean_tree(rows.to_dict("records"))
        for r in out:
            r["watching"] = r["symbol"] in watched
        return {"rows": out, "count": len(out)}

    @app.get("/api/screens")
    def list_screens(request: Request) -> list[dict]:
        return request.app.state.store.screens()

    @app.post("/api/screens")
    def save_screen(request: Request, body: ScreenBody) -> dict:
        c = screener.Criteria.from_dict(body.criteria.model_dump())
        # Remember today's matches so an alerting screen only flags stocks that enter later.
        matches = sorted(run_screen(request, c)["symbol"]) if body.alert else None
        sid = request.app.state.store.save_screen(body.name.strip(), c.to_dict(), body.alert,
                                                  matches)
        return {"id": sid, "name": body.name.strip(), "matches": len(matches or [])}

    @app.delete("/api/screens/{screen_id}")
    def delete_screen(request: Request, screen_id: int) -> dict:
        if not request.app.state.store.delete_screen(screen_id):
            raise HTTPException(404, "No such screen")
        return {"deleted": screen_id}

    # --- chart patterns ---------------------------------------------------------------
    def pattern_data(request) -> pd.DataFrame:
        """Every detected pattern with promoter context and returns; cached per refresh."""
        store: Store = request.app.state.store

        def build():
            trades = store.load_trades()
            if trades.empty:
                return patterns.to_frame([])
            syms = sorted(set(trades.loc[trades["category"].map(analysis.is_promoter), "symbol"]))
            # From a year before the first disclosure: older history adds work, not insight.
            since = trades["disclosure_date"].min() - pd.Timedelta(days=365)
            det = patterns.scan(syms, lambda s: store.load_bars(nse_ticker(s)), since)
            events = request.app.state.events.get(True, "disclosure_date")
            det = patterns.with_promoter_context(det, events)
            det = patterns.with_returns(det, lambda s: store.load_prices(nse_ticker(s)),
                                        store.load_prices(BENCHMARK))
            names = events.drop_duplicates("symbol").set_index("symbol")["company"] \
                if not events.empty else pd.Series(dtype=object)
            return det.assign(company=det["symbol"].map(names)) if not det.empty else det

        return cached(request, ("patterns",), build)

    @app.get("/api/patterns/recent")
    def recent_patterns(request: Request,
                        days: Annotated[int, Query(ge=1, le=365)] = 30,
                        direction: Literal["all", "bull", "bear"] = "all",
                        pattern: Annotated[str, Query(pattern=r"^(all|[a-z_]{1,40})$")] = "all",
                        promoter_only: bool = False) -> dict:
        det = pattern_data(request)
        if det.empty:
            return {"rows": [], "through": None}
        through = request.app.state.store.last_price_date(BENCHMARK)
        d = det[det["breakout"] >= pd.Timestamp(through) - pd.Timedelta(days=days)]
        if direction != "all":
            d = d[d["direction"] == direction]
        if pattern != "all":
            d = d[d["pattern"] == pattern]
        if promoter_only:
            d = d[d["promoter_buying"]]
        store: Store = request.app.state.store
        rows = []
        for r in d.sort_values("breakout", ascending=False).head(500).to_dict("records"):
            px = store.load_prices(nse_ticker(r["symbol"]))
            r["last_close"] = float(px.iloc[-1]) if len(px) else None
            r["since_breakout"] = (r["last_close"] / r["breakout_price"] - 1) \
                if r["last_close"] and r["breakout_price"] else None
            rows.append({k: r.get(k) for k in [*PATTERN_FIELDS, "company", "last_close",
                                               "since_breakout"]})
        return {"rows": service.clean_tree(rows), "through": through}

    @app.get("/api/patterns/stats")
    def pattern_stats(request: Request) -> dict:
        det = pattern_data(request)
        return service.clean_tree({
            "patterns": patterns.stats(det),
            "total": len(det),
            "from": det["breakout"].min() if not det.empty else None,
            "to": det["breakout"].max() if not det.empty else None,
        })

    @app.get("/api/patterns/study")
    def pattern_study(request: Request,
                      pattern: Annotated[str, Query(pattern=r"^(all|[a-z_]{1,40})$")] = "all",
                      split: Literal["pattern", "promoter"] = "pattern") -> dict:
        def run():
            det = pattern_data(request)
            if det.empty:
                return {"before": 20, "after": 120, "groups": []}
            d = det if pattern == "all" else det[det["pattern"] == pattern]
            if split == "promoter":
                label = d["promoter_buying"].map({True: "Promoters buying during the pattern",
                                                  False: "No promoter buying"})
            else:
                label = d["name"]
            e = d.rename(columns={"breakout": "event_date"})
            closes, bench = closes_and_bench(request)
            return research.study_by_label(e, label, closes, bench)

        return cached(request, ("pattern_study", pattern, split), run)

    @app.get("/api/people")
    def people(request: Request, f: F,
               min_scored: Annotated[int, Query(ge=1, le=50)] = 3) -> list[dict]:
        _, view = events_for(request, f)
        return service.people(view, min_scored)

    @app.get("/api/people/{slug}")
    def person(request: Request, slug: Annotated[str, PathParam(pattern=r"^[0-9a-z-]{1,200}$")],
               f: F) -> dict:
        events, _ = events_for(request, f)
        if f.exclude_transfers and not events.empty:
            events = events[~events["internal_transfer"]]
        out = service.person(events, slug) if not events.empty else None
        if out is None:
            raise HTTPException(404, "No promoter trades for this person")
        return out

    @app.get("/api/compare")
    def compare(request: Request, f: F,
                symbols: Annotated[str, Query(pattern=COMPARE_RE)],
                days: Annotated[int | None, Query(ge=30, le=3650)] = 365) -> dict:
        syms = list(dict.fromkeys(s.upper() for s in symbols.split(",")))
        events, _ = events_for(request, f)
        if f.exclude_transfers and not events.empty:
            events = events[~events["internal_transfer"]]
        store: Store = request.app.state.store
        return service.compare(events, syms, lambda s: store.load_prices(nse_ticker(s)), days)

    @app.get("/api/market")
    def market(request: Request, f: F) -> dict:
        _, view = events_for(request, f)
        return cached(request, ("market", f), lambda: service.market(
            view, request.app.state.store.load_prices(BENCHMARK)))

    @app.get("/api/sectors")
    def sectors(request: Request, f: F) -> dict:
        _, view = events_for(request, f)
        return service.sectors(view)

    @app.get("/api/stocks")
    def stocks(request: Request, f: F) -> list[dict]:
        events, view = events_for(request, f)
        return service.stock_list(events, view)

    @app.get("/api/stocks/{symbol}")
    def stock(request: Request, symbol: str, f: F) -> dict:
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise HTTPException(422, "Not an NSE symbol")
        events, _ = events_for(request, f)
        if events.empty or symbol not in set(events["symbol"]):
            raise HTTPException(404, f"No promoter trades for {symbol}")
        bars = request.app.state.store.load_bars(nse_ticker(symbol))
        out = service.stock(events, symbol, f.sides or ("buy", "sell"), bars, f.exclude_transfers)
        pe = pledge_events(request)
        out["pledges"] = service.clean_tree(
            pe[pe["symbol"] == symbol].to_dict("records") if not pe.empty else [])
        det = pattern_data(request)
        out["patterns"] = service.clean_tree(
            det.loc[det["symbol"] == symbol, PATTERN_FIELDS].to_dict("records")
            if not det.empty else [])
        return out

    def known_symbol(request: Request, symbol: str) -> str:
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise HTTPException(422, "Not an NSE symbol")
        events = request.app.state.events.get(False, "disclosure_date")
        if events.empty or symbol not in set(events["symbol"]):
            raise HTTPException(404, f"No promoter trades for {symbol}")
        return symbol

    # --- watchlist ------------------------------------------------------------
    @app.get("/api/watchlist")
    def watchlist(request: Request, f: F) -> list[dict]:
        store: Store = request.app.state.store
        events, _ = events_for(request, f)
        if f.exclude_transfers and not events.empty:
            events = events[~events["internal_transfer"]]
        return service.watchlist(events, store.watchlist(), f.sides or ("buy", "sell"),
                                 lambda s: store.load_prices(nse_ticker(s)))

    @app.put("/api/watchlist/{symbol}")
    def watch(request: Request, symbol: str) -> dict:
        symbol = known_symbol(request, symbol)
        request.app.state.store.watch(symbol)
        return {"symbol": symbol, "watching": True}

    @app.delete("/api/watchlist/{symbol}")
    def unwatch(request: Request, symbol: str) -> dict:
        symbol = symbol.upper()
        request.app.state.store.unwatch(symbol)
        return {"symbol": symbol, "watching": False}

    # --- alerts ----------------------------------------------------------------
    @app.get("/api/alerts")
    def list_alerts(request: Request, limit: Annotated[int, Query(ge=1, le=500)] = 100,
                    unread_only: bool = False) -> dict:
        store: Store = request.app.state.store
        return {"unread": store.unread_alerts(),
                "alerts": store.alerts(limit, unread_only)}

    @app.post("/api/alerts/read")
    def mark_read(request: Request, body: MarkRead) -> dict:
        store: Store = request.app.state.store
        store.mark_alerts_read(body.ids)
        return {"unread": store.unread_alerts()}

    @app.get("/api/alerts/settings")
    def get_alert_settings(request: Request) -> dict:
        return {"rules": alert_rules.AlertSettings.load(request.app.state.store).__dict__,
                "channels": {"telegram": bool(settings.telegram_bot_token
                                              and settings.telegram_chat_id),
                             "email": bool(settings.smtp_host and settings.alert_email_to)}}

    @app.put("/api/alerts/settings")
    def put_alert_settings(request: Request, body: AlertSettingsBody) -> dict:
        alert_rules.AlertSettings(**body.model_dump()).save(request.app.state.store)
        return get_alert_settings(request)

    last_test = {"at": 0.0}

    @app.post("/api/alerts/test")
    def test_alert() -> dict:
        channels = notify.channels_from(settings)
        if not channels:
            raise HTTPException(400, "No alert channel is configured; see the README.")
        if time.monotonic() - last_test["at"] < TEST_ALERT_COOLDOWN:
            raise HTTPException(429, "Wait a few seconds before sending another test.")
        last_test["at"] = time.monotonic()
        sample = [{"symbol": "TEST", "title": "TEST: this is a test alert from Promoter tracker",
                   "detail": "If you can read this, alerts will reach you here."}]
        errors = notify.send(sample, channels, settings.public_url)
        return {"sent": [c.name for c in channels if not any(c.name in e for e in errors)],
                "errors": errors}

    if frontend_dist is not None and (frontend_dist / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")
        index = frontend_dist / "index.html"

        @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def spa(path: str):
            # Client-side routes (/trades, /stock/ABC) all load the app shell;
            # real files at the root (favicon) are served as they are.
            if path.startswith("api/"):
                raise HTTPException(404)
            candidate = (frontend_dist / path).resolve()
            if path and candidate.is_file() and frontend_dist.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        log.warning("Frontend not built (%s missing); serving the API only", frontend_dist)

    return app


app = create_app()
