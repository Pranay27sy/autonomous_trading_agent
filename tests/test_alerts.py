import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from promoter_tracker import alerts, notify, refresh
from promoter_tracker.alerts import AlertSettings
from promoter_tracker.config import load_settings
from promoter_tracker.nse_client import parse_response
from promoter_tracker.store import Store

FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_sample.json"


def trade(person, value, direction="Buy", symbol="ABCLTD", day="2024-03-05", mode=None):
    mode = mode or ("Market Purchase" if direction == "Buy" else "Market Sale")
    return {"symbol": symbol, "company": f"{symbol} Ltd", "person": person,
            "category": "Promoter Group", "security_type": "Equity Shares",
            "quantity": 1000.0, "value": value, "txn_type": direction, "mode": mode,
            "holding_before_pct": 10.0, "holding_after_pct": 10.5, "trade_from": day,
            "trade_to": day, "intimation_date": day, "disclosure_date": day,
            "disclosure_estimated": 0}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "t.db")
    s.upsert_trades(parse_response(json.loads(FIXTURE.read_text())))  # existing history
    yield s
    s.close()


def test_first_scan_sets_a_baseline_instead_of_alerting_on_history(store):
    assert alerts.scan(store) == []
    assert store.alerts() == []


def test_watchlist_trade_and_large_trades_raise_alerts(store):
    alerts.scan(store)  # baseline
    store.watch("XYZIND")
    store.upsert_trades([
        trade("Small Buyer", 2e6, symbol="XYZIND"),            # watched: any size
        trade("Big Buyer", 6e7, symbol="NEWCO"),               # ≥ ₹5 cr buy
        trade("Tiny Buyer", 2e6, symbol="NEWCO", day="2024-03-06"),  # nothing
        trade("Big Seller", 3e8, "Sell", symbol="OTHERCO"),    # ≥ ₹25 cr sell
        trade("Gift", 9e8, symbol="GIFTCO", mode="Gift"),      # not open-market
    ])
    new = alerts.scan(store)
    assert {(a["kind"], a["symbol"]) for a in new} == {
        ("watchlist", "XYZIND"), ("big_buy", "NEWCO"), ("big_sell", "OTHERCO")}
    big = next(a for a in new if a["kind"] == "big_buy")
    assert big["title"] == "NEWCO: large promoter buy ₹6.0 cr"
    assert "holding 10.00% → 10.50%" in big["detail"]
    assert store.unread_alerts() == 3
    assert alerts.scan(store) == []  # nothing new since


def test_cluster_alert_when_a_new_buy_completes_it(store):
    alerts.scan(store)
    store.upsert_trades([trade("A", 2e6, day="2024-03-01"), trade("B", 2e6, day="2024-03-04")])
    assert [a["kind"] for a in alerts.scan(store)] == []  # only 2 promoters (+ old ones are Jan)
    store.upsert_trades([trade("C", 2e6, day="2024-03-08")])
    [cl] = alerts.scan(store)
    assert cl["kind"] == "cluster" and cl["title"].startswith("ABCLTD: 3 promoters bought")
    # Another buy inside the same cluster doesn't raise it again.
    store.upsert_trades([trade("D", 2e6, day="2024-03-09")])
    assert [a["kind"] for a in alerts.scan(store)] == []


def test_rules_can_be_turned_off(store):
    alerts.scan(store)
    AlertSettings(big_buy_value=None, cluster_min_people=None).save(store)
    store.upsert_trades([trade("Big Buyer", 6e9, symbol="NEWCO")])
    assert alerts.scan(store) == []
    assert AlertSettings.load(store).big_buy_value is None


def test_same_trade_is_never_alerted_twice(store):
    store.watch("ABCLTD")
    a = {"kind": "watchlist", "dedup_key": "k1", "symbol": "ABCLTD", "title": "t"}
    assert len(store.add_alerts([a, a])) == 1
    assert store.add_alerts([a]) == []
    store.mark_alerts_read()
    assert store.unread_alerts() == 0


def test_digest_lists_alerts_with_links():
    subject, text = notify.digest(
        [{"symbol": "JSL", "title": "JSL: large promoter buy ₹62.3 cr", "detail": "JSL Overseas"}],
        public_url="https://tracker.example/")
    assert subject == "Promoter tracker: 1 new alert"
    assert text.splitlines() == ["• JSL: large promoter buy ₹62.3 cr", "  JSL Overseas",
                                 "  https://tracker.example/stock/JSL"]


class Recorder:
    name = "recorder"

    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    def send(self, subject, text):
        if self.fail:
            raise RuntimeError("smtp down")
        self.sent.append((subject, text))


def test_a_broken_channel_does_not_stop_the_others():
    ok, broken = Recorder(), Recorder(fail=True)
    errors = notify.send([{"symbol": "A", "title": "A: x"}], [broken, ok])
    assert len(ok.sent) == 1 and errors == ["Alerts by recorder: smtp down"]


def test_telegram_error_does_not_leak_the_token(monkeypatch):
    class Resp:
        status_code = 400

        def json(self):
            return {"description": "Bad Request: chat not found"}

    monkeypatch.setattr(notify.requests, "post", lambda *a, **k: Resp())
    with pytest.raises(RuntimeError) as err:
        notify.TelegramChannel("123:SECRET", "42").send("s", "t")
    assert "chat not found" in str(err.value) and "SECRET" not in str(err.value)


def test_channels_come_from_environment_and_hide_secrets():
    s = load_settings({"PROMOTER_TELEGRAM_BOT_TOKEN": "123:SECRET", "PROMOTER_TELEGRAM_CHAT_ID": "42",
                       "PROMOTER_SMTP_HOST": "smtp.example", "PROMOTER_SMTP_PASSWORD": "pw",
                       "PROMOTER_ALERT_EMAIL_TO": "a@example.com, b@example.com"})
    assert [c.name for c in notify.channels_from(s)] == ["telegram", "email"]
    assert s.alert_email_to == ["a@example.com", "b@example.com"]
    assert "SECRET" not in repr(s) and "pw" not in repr(s)
    assert notify.channels_from(load_settings({})) == []


class Quiet:
    def fetch_pit(self, start, end, on_chunk=None):
        if on_chunk:
            on_chunk([trade("Big Buyer", 6e7, symbol="NEWCO", day="2024-02-28")])
        return []


def test_refresh_sends_new_alerts(store):
    alerts.scan(store)
    rec = Recorder()
    res = refresh.refresh_all(store, 30, client=Quiet(), downloader=lambda t, s: pd.Series(dtype=float),
                              today=date(2024, 3, 1), channels=[rec])
    assert res.alerts == 1 and len(rec.sent) == 1 and "NEWCO" in rec.sent[0][1]
    assert store.alerts()[0]["notified_at"]


def test_delivery_failure_is_a_warning_not_a_failed_refresh(store):
    alerts.scan(store)
    res = refresh.refresh_all(store, 30, client=Quiet(), downloader=lambda t, s: pd.Series(dtype=float),
                              today=date(2024, 3, 1), channels=[Recorder(fail=True)])
    assert not res.errors and res.warnings == ["Alerts by recorder: smtp down"]
    assert store.alerts()[0]["notified_at"] is None  # still visible in the app


def test_trades_in_one_stock_are_grouped_and_clusters_cover_big_buys(store):
    alerts.scan(store)
    store.watch("XYZIND")
    store.upsert_trades([
        trade("S1", 3e8, "Sell", symbol="XYZIND"), trade("S2", 1e8, "Sell", symbol="XYZIND"),
        trade("B1", 6e7, symbol="NEWCO", day="2024-03-01"),
        trade("B2", 7e7, symbol="NEWCO", day="2024-03-02"),
        trade("B3", 8e7, symbol="NEWCO", day="2024-03-03"),
    ])
    new = {a["symbol"]: a for a in alerts.scan(store)}
    assert new["XYZIND"]["title"] == "XYZIND: 2 promoter SELLs ₹40.0 cr"
    assert new["XYZIND"]["detail"].startswith("S1, S2 ·")
    assert new["NEWCO"]["kind"] == "cluster"  # not three separate big-buy alerts
    assert len(new) == 2


def test_internal_transfers_do_not_alert(store):
    alerts.scan(store)
    store.upsert_trades([trade("HoldCo", 9e8, symbol="BIGCO"),
                         {**trade("Family Trust", 9e8, "Sell", symbol="BIGCO")}])
    assert alerts.scan(store) == []


def test_high_conviction_rule(store):
    alerts.scan(store)
    AlertSettings(big_buy_value=None, cluster_min_people=None, min_conviction=30).save(store)
    store.upsert_trades([{**trade("Founder", 4e8, symbol="NEWCO"), "holding_before_pct": 10.0,
                          "holding_after_pct": 11.5}])
    [a] = alerts.scan(store)
    assert a["kind"] == "conviction" and "(score " in a["title"]
    assert "raised their stake by 1.50% of the company" in a["detail"]


def test_pledge_invocation_alerts_anywhere_and_watched_pledges(store):
    alerts.scan(store)
    store.watch("XYZIND")
    base = {"category": "Promoter Group", "security_type": "Equity Shares", "value": 47.0,
            "holding_before_pct": 5.0, "holding_after_pct": 5.0, "trade_from": "2024-03-05",
            "trade_to": "2024-03-05", "intimation_date": "2024-03-05",
            "disclosure_date": "2024-03-05", "disclosure_estimated": 0}
    store.upsert_trades([
        {**base, "symbol": "NEWCO", "company": "NewCo", "person": "Lender Victim",
         "quantity": 5e5, "txn_type": "Pledge Invoke", "mode": "Invocation of pledge"},
        {**base, "symbol": "XYZIND", "company": "XYZ", "person": "Owner",
         "quantity": 1e5, "txn_type": "Pledge", "mode": "Pledge Creation"},
        {**base, "symbol": "OTHER", "company": "Other", "person": "Someone",
         "quantity": 1e5, "txn_type": "Pledge", "mode": "Pledge Creation"},  # not watched: no alert
    ])
    titles = sorted(a["title"] for a in alerts.scan(store))
    assert len(titles) == 2
    assert titles[0].startswith("NEWCO: lender invoked pledged promoter shares (500,000 shares")
    assert titles[1].startswith("XYZIND: promoter pledged shares")


def test_saved_screen_alerts_when_a_stock_enters(store):
    alerts.scan(store)
    AlertSettings(big_buy_value=None, cluster_min_people=None).save(store)
    sid = store.save_screen("Big buyers", {"lookback_days": 365, "min_net_value": 5e7}, True, [])
    store.upsert_trades([trade("Founder", 9e7, symbol="NEWCO")])
    [a] = alerts.scan(store)
    assert a["kind"] == "screen" and a["title"] == "NEWCO: entered your screen “Big buyers”"
    assert store.screens()[0]["last_matches"] == ["NEWCO"] and store.screens()[0]["id"] == sid
    store.upsert_trades([trade("Founder", 1e7, symbol="NEWCO", day="2024-03-06")])
    assert alerts.scan(store) == []  # still in the screen: no repeat
