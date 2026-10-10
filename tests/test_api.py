import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from promoter_tracker import api, service
from promoter_tracker.config import Settings
from promoter_tracker.nse_client import parse_response
from promoter_tracker.prices import BENCHMARK
from promoter_tracker.refresh import RefreshResult
from promoter_tracker.store import Store

FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_sample.json"
ALL = {"period": "All", "min_value": 0}


def seed(path: Path) -> None:
    """The fixture's trades plus a year of prices, so returns have data."""
    store = Store(path)
    store.upsert_trades(parse_response(json.loads(FIXTURE.read_text())))
    days = pd.bdate_range("2023-12-01", periods=260)
    rng = np.random.default_rng(0)
    for ticker in (BENCHMARK, "ABCLTD.NS", "XYZIND.NS", "NEWFMT.NS"):
        store.upsert_prices(ticker, pd.Series(100 * np.cumprod(1 + rng.normal(0, 0.01, 260)),
                                              index=days))
    store.mark_refreshed()
    store.close()


def make_client(tmp_path, frontend_dist=None, seeded=True) -> TestClient:
    db = tmp_path / "t.db"
    if seeded:
        seed(db)
    settings = Settings(db_path=db, auto_refresh=False)
    return TestClient(api.create_app(settings, frontend_dist=frontend_dist))


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path) as c:
        yield c


def test_health_and_status(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    status = client.get("/api/status").json()
    assert status["last_refresh"] and status["refresh"]["state"] == "idle"
    assert status["stale"] is False and status["failed_filings"] == 0
    assert status["disclosures_through"] == "2024-02-22"
    assert status["prices_through"] == "2024-11-28"  # last of the 260 seeded bars


def test_status_flags_old_data_even_after_a_recent_failed_attempt(tmp_path):
    with make_client(tmp_path) as c:
        store = c.app.state.store
        store.set_meta("last_refresh", "2020-01-01T00:00:00+00:00")
        store.mark_refresh_attempt()  # e.g. today's run failed
        store.set_failed_filings([{"xmlFileName": "a.xml"}])
        status = c.get("/api/status").json()
        assert status["stale"] is True and status["failed_filings"] == 1
        assert status["last_attempt"] > status["last_refresh"]


def test_overview(client):
    body = client.get("/api/overview", params=ALL).json()
    k = body["kpis"]
    assert k["buy_count"] == 3 and k["sell_count"] == 1  # 4 open-market promoter trades
    assert k["net_value"] == pytest.approx(25e5 + 13e5 + 25000.5 - 4e7)
    assert body["top_sellers"][0]["symbol"] == "XYZIND"
    assert {r["direction"] for r in body["summary"]} == {"buy", "sell"}
    assert body["clusters"][0]["symbol"] == "ABCLTD"  # Ravi and Sita bought within 30 days
    assert len(body["weekly"]) == 52


def test_filters_apply(client):
    sells = client.get("/api/trades", params={**ALL, "sides": "sell"}).json()
    assert sells["total"] == 1 and sells["rows"][0]["direction"] == "sell"
    big = client.get("/api/trades", params={**ALL, "min_value": 2e6}).json()
    assert {r["symbol"] for r in big["rows"]} == {"ABCLTD", "XYZIND"}
    every = client.get("/api/trades", params={**ALL, "market_only": False}).json()
    assert every["total"] == 5  # adds the off-market transfer


def test_trade_search_and_json_safety(client):
    body = client.get("/api/trades", params={**ALL, "q": "sita"}).json()
    assert [r["person"] for r in body["rows"]] == ["Sita Kumar"]
    row = body["rows"][0]
    assert row["event_date"] == "2024-01-12" and isinstance(row["ret_5"], float)


def test_records_are_json_safe():
    df = pd.DataFrame({"d": [pd.Timestamp("2024-01-12"), pd.NaT], "x": [np.float64(1.5), np.nan],
                       "n": np.array([3, 4], dtype=np.int64), "inf": [np.inf, 1.0]})
    assert service.records(df, ["d", "x", "n", "inf", "missing"]) == [
        {"d": "2024-01-12", "x": 1.5, "n": 3, "inf": None},
        {"d": None, "x": None, "n": 4, "inf": 1.0},
    ]


def test_bad_params_are_rejected(client):
    assert client.get("/api/trades", params={"period": "2W"}).status_code == 422
    assert client.get("/api/trades", params={"sides": "hold"}).status_code == 422
    assert client.get("/api/trades", params={"min_value": -1}).status_code == 422
    assert client.get("/api/stocks/<script>").status_code == 422
    assert client.get("/api/stocks/NOPE", params=ALL).status_code == 404


def test_stock(client):
    stocks = client.get("/api/stocks", params=ALL).json()
    assert stocks[0] == {"symbol": "ABCLTD", "company": "ABC Limited", "trades": 2}
    body = client.get("/api/stocks/abcltd", params=ALL).json()
    assert body["company"] == "ABC Limited" and len(body["prices"]) == 260
    bar = body["prices"][0]
    assert set(bar) == {"time", "open", "high", "low", "close", "volume"}
    assert bar["open"] is None and bar["close"] > 0  # seeded with closes only
    assert body["kpis"]["buys"] == 2 and body["kpis"]["last_close"] > 0
    assert {t["person"] for t in body["trades"]} == {"Ravi Kumar", "Sita Kumar"}


def test_empty_database(tmp_path):
    with make_client(tmp_path, seeded=False) as c:
        body = c.get("/api/overview").json()
        assert body["kpis"]["trades"] == 0 and body["summary"] == []
        assert c.get("/api/trades").json() == {"total": 0, "rows": []}
        assert c.get("/api/stocks").json() == []


def test_refresh_runs_in_background(client, monkeypatch):
    calls = []

    def fake_refresh(store, backfill_days, progress):
        calls.append(backfill_days)
        progress("Fetching NSE insider disclosures")
        time.sleep(0.2)
        return RefreshResult(None, None, new_trades=3)

    monkeypatch.setattr(api, "refresh_all", fake_refresh)
    assert client.post("/api/refresh", params={"backfill_days": 90}).status_code == 202
    assert client.post("/api/refresh").status_code == 409  # one at a time
    for _ in range(50):
        status = client.get("/api/status").json()["refresh"]
        if not status["running"]:
            break
        time.sleep(0.05)
    assert calls == [90]
    assert status["state"] == "done" and status["result"]["new_trades"] == 3
    assert status["log"] == ["Fetching NSE insider disclosures"]


def test_events_recomputed_after_a_refresh(tmp_path):
    db = tmp_path / "t.db"
    seed(db)
    store = Store(db)
    cache = service.EventCache(store)
    first = cache.get(True, "disclosure_date")
    assert cache.get(True, "disclosure_date") is first
    store.set_meta("last_refresh", "2099-01-01T00:00:00+00:00")  # e.g. the scheduled CLI ran
    assert cache.get(True, "disclosure_date") is not first


def test_serves_frontend_with_spa_fallback(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<div id=root></div>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (dist / "favicon.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("nope")
    with make_client(tmp_path, frontend_dist=dist) as c:
        assert c.get("/").text == "<div id=root></div>"
        assert c.get("/stock/ABCLTD").text == "<div id=root></div>"  # client-side route
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/favicon.svg").text == "<svg/>"
        assert "nope" not in c.get("/../secret.txt").text
        assert c.get("/api/nope").status_code == 404
        r = c.get("/")
        assert r.headers["x-frame-options"] == "DENY"
        assert "default-src 'self'" in r.headers["content-security-policy"]


def test_weekly_series_ends_on_latest_week():
    view = pd.DataFrame({"event_date": pd.to_datetime(["2024-01-03", "2024-02-20"]),
                         "direction": ["buy", "sell"], "value": [2e7, 1e7]})
    weeks = service.weekly(view, 8)
    assert len(weeks) == 8 and weeks[0]["week"] == "2024-01-07" and weeks[-1]["week"] == "2024-02-25"
    assert weeks[0]["buy"] == 2e7 and weeks[-1]["net"] == -1e7


def test_watchlist_add_list_remove(client):
    assert client.put("/api/watchlist/abcltd").json() == {"symbol": "ABCLTD", "watching": True}
    assert client.put("/api/watchlist/NOPE").status_code == 404
    rows = client.get("/api/watchlist", params=ALL).json()
    assert [r["symbol"] for r in rows] == ["ABCLTD"]
    r = rows[0]
    assert r["company"] == "ABC Limited" and r["last_trade"]["person"] == "Sita Kumar"
    assert r["last_close"] > 0 and r["change_1m"] is not None
    assert client.delete("/api/watchlist/ABCLTD").json()["watching"] is False
    assert client.get("/api/watchlist").json() == []


def test_alerts_list_and_mark_read(client):
    store = client.app.state.store
    store.add_alerts([{"kind": "big_buy", "dedup_key": str(i), "symbol": "ABCLTD",
                       "title": f"alert {i}"} for i in range(3)])
    body = client.get("/api/alerts").json()
    assert body["unread"] == 3 and [a["title"] for a in body["alerts"]][0] == "alert 2"
    assert client.get("/api/status").json()["unread_alerts"] == 3
    first = body["alerts"][-1]["id"]
    assert client.post("/api/alerts/read", json={"ids": [first]}).json() == {"unread": 2}
    assert client.post("/api/alerts/read", json={}).json() == {"unread": 0}


def test_alert_settings_round_trip_and_validation(client):
    body = client.get("/api/alerts/settings").json()
    assert body["rules"]["big_buy_value"] == 5e7
    assert body["channels"] == {"telegram": False, "email": False}
    new = {**body["rules"], "big_buy_value": None, "cluster_min_people": 4}
    assert client.put("/api/alerts/settings", json=new).json()["rules"]["cluster_min_people"] == 4
    assert client.put("/api/alerts/settings", json={**new, "cluster_min_people": 1}).status_code == 422
    assert client.post("/api/alerts/test").status_code == 400  # no channel configured


def test_cross_site_writes_are_refused(client):
    evil = {"Origin": "https://evil.example"}
    assert client.put("/api/watchlist/ABCLTD", headers=evil).status_code == 403
    assert client.post("/api/refresh", headers=evil).status_code == 403
    same = {"Origin": "http://testserver"}
    assert client.put("/api/watchlist/ABCLTD", headers=same).status_code == 200
    assert client.get("/api/status", headers=evil).status_code == 200  # reads are fine


def test_sectors_and_cap_buckets(tmp_path):
    db = tmp_path / "t.db"
    seed(db)
    store = Store(db)
    store.upsert_company_info("ABCLTD", {"sector": "Industrials", "market_cap": 6e11})
    store.upsert_company_info("XYZIND", {"sector": "Energy", "market_cap": 3e10})
    store.close()
    with TestClient(api.create_app(Settings(db_path=db, auto_refresh=False), frontend_dist=None)) as c:
        body = c.get("/api/sectors", params=ALL).json()
        by = {r["sector"]: r for r in body["sectors"]}
        assert by["Industrials"]["buy_value"] == 25e5 + 13e5 and by["Industrials"]["top_buy"] == "ABCLTD"
        assert by["Energy"]["net_value"] == -4e7 and "Unclassified" in by  # NEWFMT has no info
        assert [r["bucket"] for r in body["caps"]] == ["Large cap", "Small cap", "Unknown"]
        stock = c.get("/api/stocks/ABCLTD", params=ALL).json()
        assert stock["sector"] == "Industrials" and stock["cap_bucket"] == "Large cap"


def test_research_endpoints(client):
    bt = client.get("/api/research/backtest", params={"hold_days": 20, "min_value": 0}).json()
    assert bt["stats"]["trades"] >= 1 and bt["equity"] and "excess" in bt["trades"][0]
    assert client.get("/api/research/backtest", params={"hold_days": 0}).status_code == 422
    assert client.get("/api/research/backtest", params={"start": "yesterday"}).status_code == 422
    es = client.get("/api/research/event-study").json()
    assert {g["group"] for g in es["groups"]} <= {"Promoter buys", "Promoter sells"}
    again = client.get("/api/research/backtest", params={"hold_days": 20, "min_value": 0}).json()
    assert again == bt  # served from the cache


def test_people_leaderboard_and_profile(client):
    people = client.get("/api/people", params={**ALL, "min_scored": 1}).json()
    ravi = next(p for p in people if p["slug"] == "ravi-kumar")
    assert ravi["companies"] == 1 and ravi["buys"] == 1 and ravi["n_60"] == 1
    assert people[0]["exc_60"] >= people[1]["exc_60"]  # ranked by track record
    prof = client.get("/api/people/ravi-kumar", params=ALL).json()
    assert prof["name"] == "Ravi Kumar" and prof["companies"][0]["symbol"] == "ABCLTD"
    assert [t["person"] for t in prof["trades_list"]] == ["Ravi Kumar"]
    assert client.get("/api/people/nobody", params=ALL).status_code == 404
    assert client.get("/api/people/BAD SLUG!").status_code == 422


def test_person_slug_merges_spelling_variants():
    from promoter_tracker.service import person_slug
    assert person_slug("Ravi  Kumar.") == person_slug("RAVI KUMAR") == "ravi-kumar"


def test_track_record_ranking_prefers_consistency_over_small_lucky_samples():
    import pandas as pd

    from promoter_tracker import service

    def buys(name, n, exc):
        return [{"person": name, "symbol": name, "company": name, "direction": "buy", "value": 1e7,
                 "signed_value": 1e7, "event_date": pd.Timestamp("2024-01-01"),
                 "exc_20": exc, "exc_60": exc, "exc_120": exc} for _ in range(n)]

    view = pd.DataFrame(buys("Lucky", 3, 0.5) + buys("Steady", 40, 0.2))
    assert [p["name"] for p in service.people(view)] == ["Steady", "Lucky"]


def test_pledges_endpoint_and_stock_pledges(tmp_path):
    db = tmp_path / "t.db"
    seed(db)
    store = Store(db)
    store.upsert_trades([{"symbol": "ABCLTD", "company": "ABC Limited", "person": "Ravi Kumar",
                          "category": "Promoters", "quantity": 1000.0, "value": 47.0,
                          "txn_type": "Pledge Invoke", "mode": "Invocation of pledge",
                          "disclosure_date": "2024-02-01", "trade_to": "2024-02-01"}])
    store.mark_refreshed()
    store.close()
    with TestClient(api.create_app(Settings(db_path=db, auto_refresh=False), frontend_dist=None)) as c:
        body = c.get("/api/pledges", params={"period": "All"}).json()
        assert body["totals"]["invoked"]["events"] == 1 and body["companies"][0]["risk"] == "high"
        assert body["events"][0]["value"] > 1000  # valued at the close, not the filed 47
        stock = c.get("/api/stocks/ABCLTD", params=ALL).json()
        assert [p["kind"] for p in stock["pledges"]] == ["invoked"]


def test_market_flow(client):
    body = client.get("/api/market", params=ALL).json()
    weeks = {w["week"]: w for w in body["weekly"]}
    assert sum(w["trades"] for w in weeks.values()) == 4
    jan14 = weeks["2024-01-14"]  # Sita's buy on 12 Jan
    assert jan14["stocks_net_buying"] == 1 and jan14["nifty"] > 0
    assert {d["day"] for d in body["daily"]} >= {"2024-01-05", "2024-01-12"}
    assert body["totals"]["weeks"] == len(body["weekly"])
