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
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import service
from .config import Settings, configure_logging, load_settings
from .prices import BENCHMARK, nse_ticker
from .refresh import RefreshInProgress, refresh_all
from .store import Store

log = logging.getLogger(__name__)

_FROM_SETTINGS = Path("<settings>")
SYMBOL_RE = re.compile(r"^[A-Z0-9&.\-]{1,20}$")


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
) -> service.Filters:
    """The filter bar's query parameters, shared by the data endpoints."""
    return service.Filters(period, tuple(s for s in sides.split(",") if s), min_value,
                           market_only, basis)


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
        threading.Thread(target=app.state.events.get, args=(True, "disclosure_date"),
                         name="warm-cache", daemon=True).start()
        yield
        store.close()

    app = FastAPI(title="Promoter tracker", version="0.3.0", lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
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
        return service.stock(events, symbol, f.sides or ("buy", "sell"), bars)

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
